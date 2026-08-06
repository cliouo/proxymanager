import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import {
  buildOpaqueSourceIndex,
  buildScrubbedPayload,
  runNamingAnalysis,
  type NamingSuggestion,
} from '@/lib/ai/namingAnalysis';
import { applyRenameTemplate } from '@/lib/proxies/naming';
import { withSource } from '@/lib/proxies/provenance';
import type { AssistantMessage, ChatMessage } from '@/lib/ai/deepseek';
import { NamingSuggestionSchema } from '@/schemas/namingAnalysis';

const node = (name: string, type = 'vless') => ({ name, type, server: 'edge.invalid', port: 443 });

function validSuggestion(): NamingSuggestion {
  return {
    template:
      '${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}',
    tw2cn: false,
    sourceAliases: {},
    recognitionRules: [],
    reason: '识别稳定，建议均衡方案。',
  };
}

function chatReturning(content: string) {
  return vi.fn(async (): Promise<AssistantMessage> => ({ content }));
}

beforeAll(() => {
  installTestHandleSecret();
});

describe('buildScrubbedPayload', () => {
  it('extracts bounded features + sanitized display names, never credentials', () => {
    const proxies = [
      withSource(
        { ...node('香港 01 user@example.com token=sk-abc123456789 https://evil.example/x?k=v') },
        { key: 'a', label: '机场A' },
      ),
      { ...node('日本 2x'), server: '203.0.113.7', port: 443 },
    ];
    const payload = buildScrubbedPayload(proxies);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('sk-abc123');
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('edge.invalid');
    // features survive; the sanitized ORIGINAL display name survives
    // (round-1: useful names are authorized after structural redaction)
    expect(payload.nodes[0]).toMatchObject({ region: 'HK' });
    expect(payload.nodes[0].name).toContain('香港');
    expect(payload.nodes[1]).toMatchObject({ region: 'JP', rate: 2 });
    // round-1: source references are keyed opaque handles WITH sanitized
    // display labels — never s0/s1 ordinals, never stable keys
    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0].id).toMatch(/^src-[0-9a-f]{16}$/);
    expect(payload.sources[0].id).not.toBe('s0');
    expect(payload.sources[0].label).toBe('机场A');
    expect(JSON.stringify(payload)).not.toContain('airport-a');
  });

  it('entry facts are exposed alongside route facts', () => {
    const payload = buildScrubbedPayload([node('香港 入口 01')]);
    expect(payload.nodes[0]).toMatchObject({ route: '入口', entry: '入口' });
  });

  it('samples deterministically and stays bounded', () => {
    const many = Array.from({ length: 300 }, (_, i) => node(`香港 ${i}`));
    const a = buildScrubbedPayload(many);
    const b = buildScrubbedPayload(many);
    expect(a.sampled).toBeLessThanOrEqual(80);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('50000 DISTINCT sources report sourcesTotal 50000 while only bounded entries serialize (pass-2 finding)', () => {
    // withSource is already imported at the top of this file
    const proxies = Array.from({ length: 50000 }, (_, i) =>
      withSource(
        { name: `香港 01 ${i}`, type: 'ss', server: 'n.invalid', port: 443 },
        {
          key: `member-${i}`,
          label: `成员${i}`,
        },
      ),
    );
    const payload = buildScrubbedPayload(proxies);
    // the SAMPLE is bounded …
    expect(payload.sampled).toBe(80);
    expect(payload.nodes.length).toBe(80);
    // … but the SEMANTIC totals are computed over the FULL input
    expect(payload.sourcesTotal).toBe(50000);
    expect(payload.sources.length).toBe(32);
    expect(payload.sourcesTruncated).toBe(true);
    expect(payload.regionsTotal).toBeGreaterThan(0);
    expect(payload.nodeCount).toBe(50000);
    // no raw names or endpoints anywhere in the payload
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('member-49999');
    expect(serialized).not.toContain('n.invalid');
  });

  it('pass-5: all 25 canonical protocol types survive the one-shot projection; unknown/case/whitespace types are null and absent', () => {
    const ALL_25 = [
      'ss',
      'ssr',
      'socks5',
      'http',
      'vmess',
      'vless',
      'snell',
      'trojan',
      'hysteria',
      'hysteria2',
      'wireguard',
      'tuic',
      'gost-relay',
      'direct',
      'dns',
      'reject',
      'rematch',
      'ssh',
      'mieru',
      'anytls',
      'sudoku',
      'masque',
      'trusttunnel',
      'openvpn',
      'tailscale',
    ];
    for (const t of ALL_25) {
      const payload = buildScrubbedPayload([
        { name: `香港 01 ${t}`, type: t, server: 'n.invalid', port: 443 },
      ]);
      expect(payload.nodes[0].type, t).toBe(t);
    }
    // unknown, case-changed and whitespace-padded types never cross
    for (const bad of ['BenignProtocolSecret', 'SS', ' ss ']) {
      const payload = buildScrubbedPayload([
        { name: '香港 01', type: bad, server: 'n.invalid', port: 443 },
      ]);
      expect(payload.nodes[0].type).toBeNull();
      expect(JSON.stringify(payload)).not.toContain(bad);
    }
  });
});

describe('runNamingAnalysis', () => {
  it('validates strict output and returns the template suggestion + scrubbed payload', async () => {
    const chat = chatReturning(JSON.stringify(validSuggestion()));
    const result = await runNamingAnalysis({
      proxies: [node('香港 01'), node('日本 2x')],
      chat: chat as never,
    });
    expect(result.suggestion.template).toContain('${region}');
    expect(result.payload.nodeCount).toBe(2);
    // the model only ever saw the scrubbed payload
    const sent = (chat.mock.calls[0] as unknown as [ChatMessage[]])[0][1].content as string;
    expect(sent).not.toContain('edge.invalid');
    expect(sent).toContain('"region"');
  });

  it('tolerates fenced JSON output', async () => {
    const chat = chatReturning('```json\n' + JSON.stringify(validSuggestion()) + '\n```');
    const result = await runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never });
    expect(result.suggestion.template).toBe(validSuggestion().template);
  });

  it('rejects invalid output with a safe message (manual workflow unaffected)', async () => {
    const chat = chatReturning('{"template": 42}');
    await expect(
      runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never }),
    ).rejects.toThrow(/无法识别/);
  });

  it('rejects non-JSON output', async () => {
    const chat = chatReturning('抱歉，我无法分析。');
    await expect(
      runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never }),
    ).rejects.toThrow(/无法识别|没有返回/);
  });

  it('rejects suggestions with a malformed template (unknown placeholder)', async () => {
    const dirty = validSuggestion();
    dirty.template = '${process} ${region}';
    const chat = chatReturning(JSON.stringify(dirty));
    await expect(
      runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never }),
    ).rejects.toThrow(/无法识别/);
  });

  it('rejects suggestions echoing credential-shaped strings', async () => {
    const dirty = validSuggestion();
    dirty.template = '${region} https://evil.example';
    const chat = chatReturning(JSON.stringify(dirty));
    await expect(
      runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never }),
    ).rejects.toThrow(/敏感|sensitive/i);
  });

  it('model failure → safe error, no partial suggestion', async () => {
    const chat = vi.fn(async () => {
      throw new Error('Server misconfigured: missing DEEPSEEK_API_KEY.');
    });
    await expect(
      runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never }),
    ).rejects.toThrow(/API Key/);
  });

  it('model failure (network) → safe generic error', async () => {
    const chat = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(
      runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never }),
    ).rejects.toThrow(/暂时不可用/);
  });

  it('pass-5: suggestion keeps OPAQUE src handles on every external surface; trusted internal resolution applies them', async () => {
    const proxies = [
      withSource(node('香港 01'), { key: 'airport-a', label: '机场A' }),
      withSource(node('香港 02'), { key: 'airport-a', label: '机场A' }),
      withSource(node('日本 01'), { key: 'airport-b', label: '机场B' }),
    ];
    const suggestion = validSuggestion();
    // keyed by the OPAQUE src handle — the model never sees s0 ordinals or
    // stable keys
    const index = buildOpaqueSourceIndex(proxies);
    const opaqueId = index.keyToId.get('airport-a') as string;
    expect(opaqueId).toMatch(/^src-[0-9a-f]{16}$/);
    suggestion.sourceAliases = { [opaqueId]: '改名机场' };
    const chat = chatReturning(JSON.stringify(suggestion));
    const result = await runNamingAnalysis({ proxies, chat: chat as never });

    // the returned suggestion KEEPS the src handle — no stable key anywhere
    // on the external surface (pass-5 blocker)
    expect(result.suggestion.sourceAliases).toEqual({ [opaqueId]: '改名机场' });
    expect(JSON.stringify(result.suggestion)).not.toContain('airport-a');
    const sent = (chat.mock.calls[0] as unknown as [ChatMessage[]])[0][1].content as string;
    // round-1: the SAFE display label 机场A is authorized display content —
    // it survives; the stable key never does
    expect(sent).toContain('机场A');
    expect(sent).not.toContain('airport-a');
    expect(sent).not.toContain('s0');
    expect(sent).not.toContain('s1');

    // TRUSTED internal resolution (immediately before apply) translates the
    // unambiguous handle to the stable key the executor keys on
    const { resolveSourceAliasKeys } = await import('@/lib/services/sourceAliasResolver');
    const stable = resolveSourceAliasKeys(result.suggestion.sourceAliases, [
      'airport-a',
      'airport-b',
    ]);
    expect(stable).toEqual({ 'airport-a': '改名机场' });

    // and the resolved suggestion applies to deterministic naming
    const renamed = applyRenameTemplate(proxies, {
      template: suggestion.template,
      sourceAliases: stable,
    });
    expect(renamed.proxies[0].name).toContain('改名机场');
    expect(renamed.proxies[0].name).not.toContain('机场A');
  });

  it('pass-5: invented src-handle alias keys are rejected at the analysis boundary', async () => {
    const proxies = [withSource(node('香港 01'), { key: 'airport-a', label: '机场A' })];
    const suggestion = validSuggestion();
    // format-valid but NOT an emitted handle
    suggestion.sourceAliases = { 'src-0000000000000000': '改名机场' };
    const chat = chatReturning(JSON.stringify(suggestion));
    await expect(runNamingAnalysis({ proxies, chat: chat as never })).rejects.toThrow(/无法识别/);
  });

  it('rejects suggestions keyed by UNKNOWN opaque ids', async () => {
    const proxies = [withSource(node('香港 01'), { key: 'airport-a', label: '机场A' })];
    const suggestion = validSuggestion();
    suggestion.sourceAliases = { s9: '编造的来源' };
    const chat = chatReturning(JSON.stringify(suggestion));
    await expect(runNamingAnalysis({ proxies, chat: chat as never })).rejects.toThrow(/无法识别/);
  });

  it('round-1 direct probe: sanitized ORIGINAL names reach the model bounded; credentials never do', async () => {
    const proxies = [
      { name: 'BenignUniqueNodeName', type: 'ss', server: 'n1.invalid', port: 443 },
      { name: '机场甲 专线A', type: 'vmess', server: 'n2.invalid', port: 8443 },
      { name: '香港 01', type: 'trojan', server: 'n3.invalid', port: 443 },
    ];
    const payload = buildScrubbedPayload(proxies);
    const serialized = JSON.stringify(payload);
    // round-1 (invariant 6): sanitized original display names ARE authorized
    // display content — HK-01-style names survive bounded; only credential-
    // shaped spans and connection fields never cross
    for (const seed of ['BenignUniqueNodeName', '机场甲', '专线A', '香港 01']) {
      expect(serialized, `payload should keep ${seed}`).toContain(seed);
    }
    for (const seed of ['n1.invalid', '8443', 'n2.invalid', 'n3.invalid']) {
      expect(serialized, `payload leaks ${seed}`).not.toContain(seed);
    }
    // byte bound (the model-payload budget guard must stay satisfied)
    expect(serialized.length).toBeLessThan(64 * 1024);
    // canonical facts survive: residual PRESENCE flags + true node count
    expect(payload.nodes.every((n) => n.hasResidual === true)).toBe(true);
    expect(payload.nodeCount).toBe(3);
    expect(payload.nodes.every((n) => (n as { frag?: unknown }).frag === undefined)).toBe(true);

    // the MODEL MESSAGE (exact serialization runNamingAnalysis sends) keeps
    // the useful names and stays free of connection fields
    const captured: string[] = [];
    const chat = (async (
      messages: Array<{ role: string; content: string }>,
    ): Promise<AssistantMessage> => {
      captured.push(messages[1]?.content ?? '');
      return { content: JSON.stringify(validSuggestion()) };
    }) as unknown as typeof import('@/lib/ai/deepseek').deepseekChat;
    await runNamingAnalysis({ proxies, chat });
    const message = captured[0];
    expect(message).toContain('hasResidual');
    expect(message).toContain('香港 01');
    for (const seed of ['n1.invalid', '8443', 'n2.invalid', 'n3.invalid']) {
      expect(message, `model message leaks ${seed}`).not.toContain(seed);
    }
  });
});

describe('HIGH-A — model-output tw2cn default (complete-plan boundary)', () => {
  const BASE = {
    template: '${emoji} ${region}',
    sourceAliases: {},
    recognitionRules: [],
    reason: '识别稳定。',
  };

  it('a suggestion OMITTING tw2cn parses to explicit false; true/false stay exact; non-boolean rejects', () => {
    const omitted = NamingSuggestionSchema.safeParse(BASE);
    expect(omitted.success).toBe(true);
    if (!omitted.success) return;
    expect(omitted.data.tw2cn).toBe(false);
    expect(Object.hasOwn(omitted.data, 'tw2cn')).toBe(true);
    expect(JSON.stringify(omitted.data)).toContain('"tw2cn":false');

    const explicitTrue = NamingSuggestionSchema.safeParse({ ...BASE, tw2cn: true });
    expect(explicitTrue.success).toBe(true);
    if (explicitTrue.success) expect(explicitTrue.data.tw2cn).toBe(true);

    const explicitFalse = NamingSuggestionSchema.safeParse({ ...BASE, tw2cn: false });
    expect(explicitFalse.success).toBe(true);
    if (explicitFalse.success) expect(explicitFalse.data.tw2cn).toBe(false);

    for (const bad of ['yes', 1, null]) {
      expect(NamingSuggestionSchema.safeParse({ ...BASE, tw2cn: bad }).success, String(bad)).toBe(
        false,
      );
    }
  });

  it('runNamingAnalysis model-output path: omitted tw2cn in model JSON becomes false in the suggestion', async () => {
    // a COMPLETE plan may omit tw2cn — the boundary normalizes it to false
    const raw = JSON.stringify(BASE);
    const chat = chatReturning(raw);
    const result = await runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never });
    expect(result.suggestion.tw2cn).toBe(false);
    // and the whole suggestion round-trips as a complete explicit plan
    expect(JSON.stringify(result.suggestion)).toContain('"tw2cn":false');
  });
});

describe('strict nested AI output (finding 4)', () => {
  it('rejects unknown nested fields under the suggestion', async () => {
    const dirty = validSuggestion() as Record<string, unknown>;
    dirty.unknown_nested = true;
    const chat = chatReturning(JSON.stringify(dirty));
    await expect(
      runNamingAnalysis({ proxies: [node('香港 01')], chat: chat as never }),
    ).rejects.toThrow(/无法识别/);
  });
});

describe('payload leak closure (finding 3)', () => {
  it('buildScrubbedPayload never carries hostnames or trailing-:: forms', () => {
    const proxies = [
      { ...node('edge.airport.ai 香港 2001:db8:: ::192.0.2.1') },
      { ...node('edge.airport.moe fe80:: 出口') },
    ];
    const payload = buildScrubbedPayload(proxies);
    const serialized = JSON.stringify(payload);
    for (const needle of ['airport.ai', 'airport.moe', '2001:db8', 'fe80', '192.0.2.1', '::']) {
      expect(serialized).not.toContain(needle);
    }
  });
});
