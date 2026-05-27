import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Collection,
  ProxyGroup,
  ProxyGroupTemplate,
  Rule,
  Subscription,
} from '@/schemas';

/**
 * The repo modules read process.env at import time via getRedis(); short-
 * circuit them with a stub so resolve()'s snapshot write/invalidate never
 * touch Redis in tests.
 */
vi.mock('@/lib/repos/resolvedRepo', () => ({
  setResolvedSnapshot: vi.fn(async () => undefined),
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));

vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionContent: vi.fn(),
}));

import { resolveConfig } from '@/lib/engine/resolve';
import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import { setResolvedSnapshot } from '@/lib/repos/resolvedRepo';

const resolveSubMock = resolveSubscriptionContent as unknown as ReturnType<typeof vi.fn>;
const snapshotMock = setResolvedSnapshot as unknown as ReturnType<typeof vi.fn>;

const BASE_WITH_LITERAL = `mixed-port: 7890
proxies:
  - name: 直连
    type: direct
proxy-groups:
  - name: 默认
    type: select
    proxies: [直连]
rules:
  # === ANCHOR: manual ===
  - MATCH,默认
`;

function makeSub(over: Partial<Subscription>): Subscription {
  return {
    id: crypto.randomUUID(),
    name: 'a',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 600_000,
    tags: [],
    operators: [],
    ...over,
  } as Subscription;
}

function providerYaml(items: Array<{ name: string; server?: string }>): string {
  return [
    'proxies:',
    ...items.map(
      (i) => `  - { name: ${i.name}, type: ss, server: ${i.server ?? 'h.example'}, port: 8388, cipher: aes-128-gcm, password: p }`,
    ),
    '',
  ].join('\n');
}

beforeEach(() => {
  resolveSubMock.mockReset();
  snapshotMock.mockClear();
});

describe('resolveConfig — subscription injection', () => {
  it('appends every enabled subscription\'s nodes into proxies', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }, { name: 'JP-02' }]), proxyCount: 2 })
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'US-01' }]), proxyCount: 1 });

    const subs = [makeSub({ name: 'air-a' }), makeSub({ name: 'air-b' })];
    const result = await resolveConfig(BASE_WITH_LITERAL, [], subs, [], [], {});

    expect(result.inlinedProxyCount).toBe(3);
    expect(result.nodeNames).toEqual(['直连', 'HK-01', 'JP-02', 'US-01']);
    expect(result.subscriptions.map((s) => [s.name, s.injectedCount])).toEqual([
      ['air-a', 2],
      ['air-b', 1],
    ]);
    expect(result.content).toContain('HK-01');
    expect(result.content).toContain('US-01');
  });

  it('skips disabled subscriptions entirely', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });

    const subs = [makeSub({ name: 'on' }), makeSub({ name: 'off', enabled: false })];
    const result = await resolveConfig(BASE_WITH_LITERAL, [], subs, [], [], {});

    expect(resolveSubMock).toHaveBeenCalledTimes(1);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.inlinedProxyCount).toBe(1);
  });

  it('applies node_prefix and reflects it in the final names', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });
    const result = await resolveConfig(
      BASE_WITH_LITERAL,
      [],
      [makeSub({ name: 'a', node_prefix: '[A] ' })],
      [],
      [],
      {},
    );
    expect(result.nodeNames).toContain('[A] HK-01');
    expect(result.content).toContain('[A] HK-01');
  });

  it('drops cross-source name collisions, keeps the first, reports them', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01', server: 'a.example' }]), proxyCount: 1 })
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01', server: 'b.example' }]), proxyCount: 1 });

    const result = await resolveConfig(
      BASE_WITH_LITERAL,
      [],
      [makeSub({ name: 'first' }), makeSub({ name: 'second' })],
      [],
      [],
      {},
    );

    expect(result.inlinedProxyCount).toBe(1);
    expect(result.collisions).toEqual([
      { name: 'HK-01', keptFrom: 'first', droppedFrom: ['second'] },
    ]);
    // The first writer's server must be the one that lands in the final YAML.
    expect(result.content).toContain('a.example');
    expect(result.content).not.toContain('b.example');
  });

  it('drops a sub node whose name collides with a literal base proxy (keptFrom null)', async () => {
    resolveSubMock.mockResolvedValueOnce({
      yaml: providerYaml([{ name: '直连' }, { name: 'HK-01' }]),
      proxyCount: 2,
    });

    const result = await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {});

    expect(result.collisions).toEqual([
      { name: '直连', keptFrom: null, droppedFrom: ['a'] },
    ]);
    expect(result.inlinedProxyCount).toBe(1);
    expect(result.nodeNames).toEqual(['直连', 'HK-01']);
  });

  it('strips deprecated pm-inline-collections and emits a warning', async () => {
    const baseWithLegacy = `${BASE_WITH_LITERAL}\npm-inline-collections:\n  - old-pool\n`;
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'X' }]), proxyCount: 1 });

    const result = await resolveConfig(baseWithLegacy, [], [makeSub({ name: 'a' })], [], [], {});

    expect(result.content).not.toContain('pm-inline-collections');
    expect(result.warnings.some((w) => w.includes('pm-inline-collections'))).toBe(true);
    expect(result.warnings[0]).toContain('old-pool');
  });

  it('tolerates a failed subscription when ignoreFailedSubs is on (default)', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 })
      .mockRejectedValueOnce(new Error('upstream 502'));

    const result = await resolveConfig(
      BASE_WITH_LITERAL,
      [],
      [makeSub({ name: 'a' }), makeSub({ name: 'b' })],
      [],
      [],
      {},
    );

    expect(result.inlinedProxyCount).toBe(1);
    const failed = result.subscriptions.find((s) => s.name === 'b');
    expect(failed?.error).toContain('upstream 502');
  });

  it('surfaces stale flag from the fetcher', async () => {
    resolveSubMock.mockResolvedValueOnce({
      yaml: providerYaml([{ name: 'HK-01' }]),
      proxyCount: 1,
      stale: true,
      staleReason: 'connect ECONNREFUSED',
    });

    const result = await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {});

    const status = result.subscriptions[0];
    expect(status.stale).toBe(true);
    expect(status.staleReason).toContain('ECONNREFUSED');
  });

  it('still runs renderBase for rules + rule-providers', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });

    const rule: Rule = {
      id: 'r1',
      anchor: 'manual',
      type: 'DOMAIN-SUFFIX',
      value: 'example.com',
      policy: '默认',
      rank: 10,
      source: 'manual',
      added_at: 0,
      updated_at: 0,
    };

    const result = await resolveConfig(
      BASE_WITH_LITERAL,
      [rule],
      [makeSub({ name: 'a' })],
      [],
      [],
      {},
    );

    expect(result.content).toContain('DOMAIN-SUFFIX,example.com,默认');
    expect(result.anchorsApplied.find((a) => a.anchor === 'manual')?.ruleCount).toBe(1);
  });

  it('writes the resolved snapshot by default', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });
    await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {});
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    const [snapshot] = snapshotMock.mock.calls[0];
    expect(snapshot.nodeNames).toContain('HK-01');
  });

  it('skips snapshot persistence when persistSnapshot is false', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });
    await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {
      persistSnapshot: false,
    });
    expect(snapshotMock).not.toHaveBeenCalled();
  });
});

/* ─── E1: managed proxy-groups (hash-rendered) ─────────────────────── */

/** Skeleton with the PROXY-GROUPS marker in place of a literal block. Post-migration shape. */
const BASE_WITH_MARKER = `mixed-port: 7890
proxies:
  - name: 直连
    type: direct

# === PROXY-GROUPS ===

rules:
  # === ANCHOR: manual ===
  - MATCH,默认
`;

function makeGroup(over: Partial<ProxyGroup>): ProxyGroup {
  const now = 1_700_000_000;
  return {
    id: crypto.randomUUID(),
    kind: 'raw',
    name: 'g',
    type: 'select',
    rank: 10,
    updated_at: now,
    ...over,
  } as ProxyGroup;
}

function makeTemplate(over: Partial<ProxyGroupTemplate>): ProxyGroupTemplate {
  const now = 1_700_000_000;
  return {
    id: crypto.randomUUID(),
    name: 't',
    updated_at: now,
    ...over,
  } as ProxyGroupTemplate;
}

describe('resolveConfig — managed proxy-groups', () => {
  it('replaces the marker with the rendered proxy-groups block from the hash', async () => {
    resolveSubMock.mockResolvedValueOnce({
      yaml: providerYaml([{ name: 'HK-01' }]),
      proxyCount: 1,
    });
    const g1 = makeGroup({ name: '默认', type: 'select', proxies: ['HK-01', '直连'], rank: 10 });
    const g2 = makeGroup({
      name: '香港',
      type: 'url-test',
      'include-all-proxies': true,
      filter: 'HK',
      url: 'http://www.gstatic.com/generate_204',
      interval: 600,
      rank: 20,
    });

    const result = await resolveConfig(
      BASE_WITH_MARKER,
      [],
      [makeSub({ name: 'a' })],
      [g1, g2],
      [],
      {},
    );

    expect(result.proxyGroupCount).toBe(2);
    expect(result.content).not.toContain('# === PROXY-GROUPS ===');
    expect(result.content).toContain('proxy-groups:');
    expect(result.content).toContain('name: 默认');
    expect(result.content).toContain('name: 香港');
    // Rank order preserved in render output.
    expect(result.content.indexOf('name: 默认')).toBeLessThan(result.content.indexOf('name: 香港'));
  });

  it('renders groups in rank order, ties broken by name', async () => {
    const a = makeGroup({ name: 'z-low', rank: 5 });
    const b = makeGroup({ name: 'a-high', rank: 100 });
    const c = makeGroup({ name: 'b-tied', rank: 50 });
    const d = makeGroup({ name: 'a-tied', rank: 50 });

    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [a, b, c, d], [], {});
    const order = ['z-low', 'a-tied', 'b-tied', 'a-high'].map((n) =>
      result.content.indexOf(`name: ${n}`),
    );
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i]).toBeLessThan(order[i + 1]);
    }
  });

  it('merges template fields underneath the group (group wins, template fills gaps)', async () => {
    const tpl = makeTemplate({
      name: 'pr',
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 600,
      tolerance: 50,
    });
    const g = makeGroup({
      name: 'OpenAI',
      type: 'url-test', // matches template; harmless
      template_id: tpl.id,
      proxies: ['DIRECT'],
      // group does NOT set url/interval/tolerance — comes from template
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [tpl], {});
    expect(result.content).toContain('url: http://www.gstatic.com/generate_204');
    expect(result.content).toContain('interval: 600');
    expect(result.content).toContain('tolerance: 50');
  });

  it('group field overrides template field on the same key', async () => {
    const tpl = makeTemplate({ name: 'pr', interval: 600 });
    const g = makeGroup({ name: 'X', template_id: tpl.id, interval: 9999, type: 'url-test' });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [tpl], {});
    expect(result.content).toContain('interval: 9999');
    expect(result.content).not.toContain('interval: 600');
  });

  it('warns and renders without merge when template_id is dangling', async () => {
    const g = makeGroup({
      name: 'X',
      type: 'url-test',
      template_id: '00000000-0000-0000-0000-000000000000',
      url: 'http://probe',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {});
    expect(result.warnings.some((w) => w.includes('模板'))).toBe(true);
    expect(result.content).toContain('name: X');
    expect(result.content).toContain('url: http://probe');
  });

  it('warns when hash has groups but the base lacks the marker', async () => {
    const g = makeGroup({ name: 'orphan' });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [], [g], [], {});
    expect(result.warnings.some((w) => w.includes('PROXY-GROUPS'))).toBe(true);
    // Literal proxy-group ("默认") from the base survives unchanged.
    expect(result.content).toContain('name: 默认');
    // The hash group did not get injected because there's no marker.
    expect(result.content).not.toContain('name: orphan');
  });

  it('empty hash leaves the marker as no-op (no proxy-groups block emitted)', async () => {
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [], [], {});
    expect(result.proxyGroupCount).toBe(0);
    expect(result.content).not.toContain('# === PROXY-GROUPS ===');
    expect(result.content).not.toContain('proxy-groups:');
  });

  it('single-sub binding builds filter from sub.node_prefix', async () => {
    resolveSubMock.mockResolvedValueOnce({
      yaml: providerYaml([{ name: 'HK-01' }, { name: 'JP-01' }]),
      proxyCount: 2,
    });
    const sub = makeSub({ name: 'air-a', node_prefix: '[A] ' });
    const g = makeGroup({
      name: 'air-a-only',
      kind: 'single-sub',
      bound_subscription_id: sub.id,
      type: 'select',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {});
    // Filter generated from the prefix, regex-escaped for the bracket.
    // yaml.stringify double-quotes strings with backslashes and doubles them;
    // the rendered literal bytes are: filter: "^\\[A\\] "
    expect(result.content).toContain('filter: "^\\\\[A\\\\] "');
    expect(result.content).toContain('include-all-proxies: true');
    // Sub nodes still land in proxies:.
    expect(result.content).toContain('[A] HK-01');
  });

  it('single-sub warns when bound sub has no node_prefix', async () => {
    resolveSubMock.mockResolvedValueOnce({
      yaml: providerYaml([{ name: 'X' }]),
      proxyCount: 1,
    });
    const sub = makeSub({ name: 'air-a' }); // no node_prefix
    const g = makeGroup({
      name: 'sub-no-prefix',
      kind: 'single-sub',
      bound_subscription_id: sub.id,
      type: 'select',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {});
    expect(result.warnings.some((w) => w.includes('node_prefix'))).toBe(true);
    expect(result.content).not.toMatch(/filter: \^/);
  });

  it('single-sub warns when bound subscription id is dangling', async () => {
    const g = makeGroup({
      name: 'dangling',
      kind: 'single-sub',
      bound_subscription_id: '00000000-0000-0000-0000-000000000000',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {});
    expect(result.warnings.some((w) => w.includes('订阅源') && w.includes('不存在'))).toBe(true);
  });

  it('collection-scope binding builds proxies from member-sub nodes', async () => {
    resolveSubMock
      .mockResolvedValueOnce({
        yaml: providerYaml([{ name: 'HK-01' }, { name: 'HK-02' }]),
        proxyCount: 2,
      })
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'JP-01' }]), proxyCount: 1 });
    const subA = makeSub({ name: 'air-a' });
    const subB = makeSub({ name: 'air-b' });
    const col: Collection = {
      id: crypto.randomUUID(),
      name: 'asia',
      enabled: true,
      type: 'select',
      subscription_ids: [subA.id, subB.id],
      subscription_tags: [],
    } as Collection;
    const g = makeGroup({
      name: 'asia-scope',
      kind: 'collection-scope',
      bound_collection_id: col.id,
      type: 'select',
    });
    const result = await resolveConfig(
      BASE_WITH_MARKER,
      [],
      [subA, subB],
      [g],
      [],
      { collections: [col] },
    );
    // proxies list includes all member-sub survivors in member-sub order.
    expect(result.content).toMatch(/name: asia-scope[^]*proxies:[^]*HK-01[^]*HK-02[^]*JP-01/);
  });

  it('collection-scope warns when bound collection has no nodes', async () => {
    const col: Collection = {
      id: crypto.randomUUID(),
      name: 'empty',
      enabled: true,
      type: 'select',
      subscription_ids: [],
      subscription_tags: [],
    } as Collection;
    const g = makeGroup({
      name: 'empty-scope',
      kind: 'collection-scope',
      bound_collection_id: col.id,
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {
      collections: [col],
    });
    expect(result.warnings.some((w) => w.includes('无可用节点'))).toBe(true);
  });

  it('non-bound presets (region/system/service/...) render as raw fields', async () => {
    // kind only labels the form intent — these groups render their explicit
    // fields verbatim, no special resolve-time transformation.
    const g = makeGroup({
      name: 'HK',
      kind: 'region',
      type: 'url-test',
      'include-all-proxies': true,
      filter: '^香港|HK',
      url: 'http://probe',
      interval: 600,
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {});
    expect(result.content).toContain('filter: ^香港|HK');
    expect(result.content).toContain('include-all-proxies: true');
  });

  it('preserves all native fields the group sets', async () => {
    const g = makeGroup({
      name: 'full',
      type: 'load-balance',
      proxies: ['a', 'b'],
      filter: 'HK',
      'exclude-filter': 'expire',
      'exclude-type': 'Direct,Reject',
      'include-all-proxies': true,
      'disable-udp': true,
      hidden: false,
      strategy: 'round-robin',
      url: 'http://probe',
      interval: 300,
      'expected-status': '200',
      'dialer-proxy': '前置',
      icon: 'https://example/i.png',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {});
    expect(result.content).toContain('name: full');
    expect(result.content).toContain('type: load-balance');
    expect(result.content).toContain('filter: HK');
    expect(result.content).toContain('exclude-filter: expire');
    expect(result.content).toContain('exclude-type:');
    expect(result.content).toContain('include-all-proxies: true');
    expect(result.content).toContain('disable-udp: true');
    expect(result.content).toContain('strategy: round-robin');
    expect(result.content).toContain('expected-status:');
    expect(result.content).toContain('dialer-proxy:');
  });
});
