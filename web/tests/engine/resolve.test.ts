import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type {
  Collection,
  ProxyGroup,
  ProxyGroupTemplate,
  Rule,
  RuleSet,
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
  resolveSubscriptionProxies: vi.fn(),
}));

import { resolveConfig } from '@/lib/engine/resolve';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import { setResolvedSnapshot } from '@/lib/repos/resolvedRepo';

const resolveSubMock = resolveSubscriptionProxies as unknown as ReturnType<typeof vi.fn>;
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

/** Parsed proxy objects, matching what resolveSubscriptionProxies returns post-pipeline. */
function providerProxies(
  items: Array<{ name: string; server?: string }>,
): Record<string, unknown>[] {
  return items.map((i) => ({
    name: i.name,
    type: 'ss',
    server: i.server ?? 'h.example',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'p',
  }));
}

beforeEach(() => {
  resolveSubMock.mockReset();
  snapshotMock.mockClear();
});

describe('resolveConfig — subscription injection', () => {
  it("appends every enabled subscription's nodes into proxies", async () => {
    resolveSubMock
      .mockResolvedValueOnce({
        proxies: providerProxies([{ name: 'HK-01' }, { name: 'JP-02' }]),
        proxyCount: 2,
      })
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'US-01' }]), proxyCount: 1 });

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
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }]),
      proxyCount: 1,
    });

    const subs = [makeSub({ name: 'on' }), makeSub({ name: 'off', enabled: false })];
    const result = await resolveConfig(BASE_WITH_LITERAL, [], subs, [], [], {});

    expect(resolveSubMock).toHaveBeenCalledTimes(1);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.inlinedProxyCount).toBe(1);
  });

  it('injects subscription nodes under their original (unprefixed) names', async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }]),
      proxyCount: 1,
    });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {});
    expect(result.nodeNames).toContain('HK-01');
    expect(result.content).toContain('HK-01');
    // node_prefix is gone — no bracketed prefix is ever prepended.
    expect(result.content).not.toContain('[A] HK-01');
  });

  it('drops cross-source name collisions, keeps the first, reports them', async () => {
    resolveSubMock
      .mockResolvedValueOnce({
        proxies: providerProxies([{ name: 'HK-01', server: 'a.example' }]),
        proxyCount: 1,
      })
      .mockResolvedValueOnce({
        proxies: providerProxies([{ name: 'HK-01', server: 'b.example' }]),
        proxyCount: 1,
      });

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
      proxies: providerProxies([{ name: '直连' }, { name: 'HK-01' }]),
      proxyCount: 2,
    });

    const result = await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {});

    expect(result.collisions).toEqual([{ name: '直连', keptFrom: null, droppedFrom: ['a'] }]);
    expect(result.inlinedProxyCount).toBe(1);
    expect(result.nodeNames).toEqual(['直连', 'HK-01']);
  });

  it('strips deprecated pm-inline-collections and emits a warning', async () => {
    const baseWithLegacy = `${BASE_WITH_LITERAL}\npm-inline-collections:\n  - old-pool\n`;
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'X' }]),
      proxyCount: 1,
    });

    const result = await resolveConfig(baseWithLegacy, [], [makeSub({ name: 'a' })], [], [], {});

    expect(result.content).not.toContain('pm-inline-collections');
    expect(result.warnings.some((w) => w.includes('pm-inline-collections'))).toBe(true);
    expect(result.warnings[0]).toContain('old-pool');
  });

  it('tolerates a failed subscription when ignoreFailedSubs is on (default)', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'HK-01' }]), proxyCount: 1 })
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
      proxies: providerProxies([{ name: 'HK-01' }]),
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
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }]),
      proxyCount: 1,
    });

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

  it('writes the resolved snapshot keyed by the given profile id (P2-5)', async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }]),
      proxyCount: 1,
    });
    await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {
      snapshotProfileId: 'prof-1',
    });
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    const [profileId, snapshot] = snapshotMock.mock.calls[0];
    expect(profileId).toBe('prof-1');
    expect(snapshot.profileId).toBe('prof-1');
    expect(snapshot.nodeNames).toContain('HK-01');
  });

  it('does not persist a snapshot when no snapshotProfileId is given (P2-5)', async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }]),
      proxyCount: 1,
    });
    await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {});
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('skips snapshot persistence when persistSnapshot is false', async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }]),
      proxyCount: 1,
    });
    await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], [], {
      persistSnapshot: false,
      snapshotProfileId: 'prof-1',
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
      proxies: providerProxies([{ name: 'HK-01' }]),
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

  it('realizes a chained-proxy wrap as a cloned proxies entry, not a proxy-group', async () => {
    const base = `mixed-port: 7890
proxies:
  - name: B
    type: ss
    server: b.example.com
    port: 443
    cipher: aes-128-gcm
    password: pw
  - name: F
    type: ss
    server: f.example.com
    port: 443
    cipher: aes-128-gcm
    password: pw

# === PROXY-GROUPS ===

rules:
  - MATCH,DIRECT
`;
    const wrap = makeGroup({
      name: 'chain:F-to-B',
      type: 'select',
      proxies: ['B'],
      'dialer-proxy': 'F',
    });
    const result = await resolveConfig(base, [], [], [wrap], [], {});

    // The wrap is NOT emitted as a proxy-group…
    expect(result.proxyGroupCount).toBe(0);
    expect(result.content).not.toContain('proxy-groups:');
    // …it's a cloned proxies entry carrying dialer-proxy + the backend config.
    expect(result.content).toContain('name: chain:F-to-B');
    expect(result.content).toContain('dialer-proxy: F');
    const cloneIdx = result.content.indexOf('name: chain:F-to-B');
    const dialerIdx = result.content.indexOf('dialer-proxy: F');
    const rulesIdx = result.content.indexOf('rules:');
    // The clone (and its dialer-proxy) live in the proxies block, before rules.
    expect(dialerIdx).toBeGreaterThan(cloneIdx);
    expect(dialerIdx).toBeLessThan(rulesIdx);
  });

  it('excludes the chain clone from a smart front pool (no include-all loop)', async () => {
    const base = `mixed-port: 7890
proxies:
  - name: B
    type: ss
    server: b.example.com
    port: 443
    cipher: aes-128-gcm
    password: pw

# === PROXY-GROUPS ===

rules:
  - MATCH,DIRECT
`;
    const pool = makeGroup({
      name: 'pool:B',
      kind: 'filter',
      type: 'fallback',
      'include-all-proxies': true,
      filter: 'HK',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      rank: 10,
    });
    const wrap = makeGroup({
      name: 'chain:pool-to-B',
      type: 'select',
      proxies: ['B'],
      'dialer-proxy': 'pool:B',
      rank: 20,
    });
    const result = await resolveConfig(base, [], [], [pool, wrap], [], {});

    const doc = parse(result.content) as {
      proxies: Array<Record<string, unknown>>;
      'proxy-groups': Array<Record<string, unknown>>;
    };
    // Only the pool renders as a group; the wrap became a cloned proxy.
    expect(result.proxyGroupCount).toBe(1);
    const clone = doc.proxies.find((p) => p.name === 'chain:pool-to-B');
    expect(clone?.['dialer-proxy']).toBe('pool:B');
    // The pool's exclude-filter drops the clone so include-all can't loop it back.
    const poolGroup = doc['proxy-groups'].find((g) => g.name === 'pool:B');
    expect(poolGroup?.['exclude-filter']).toContain('chain:pool-to-B');
  });

  const BASE_WITH_F = `mixed-port: 7890
proxies:
  - name: F
    type: ss
    server: f.example.com
    port: 443
    cipher: aes-128-gcm
    password: pw

# === PROXY-GROUPS ===

rules:
  - MATCH,DIRECT
`;

  function makeRule(over: Partial<Rule>): Rule {
    return {
      id: crypto.randomUUID(),
      anchor: 'manual',
      type: 'DOMAIN',
      value: 'example.com',
      policy: 'DIRECT',
      rank: 10,
      source: 'manual',
      added_at: 1_700_000_000,
      updated_at: 1_700_000_000,
      ...over,
    } as Rule;
  }

  it('prunes a chain wrap whose backend node is missing (renamed/dropped) instead of emitting a group that crashes mihomo', async () => {
    // Backend "B-GONE" doesn't exist in proxies (e.g. it was renamed away).
    const wrap = makeGroup({
      name: 'chain:F-to-B',
      type: 'select',
      proxies: ['B-GONE'],
      'dialer-proxy': 'F',
    });
    const result = await resolveConfig(BASE_WITH_F, [], [], [wrap], [], {});

    // The broken wrap is gone entirely — no clone, no dangling group.
    expect(result.content).not.toContain('chain:F-to-B');
    expect(result.content).not.toContain('B-GONE');
    expect(result.proxyGroupCount).toBe(0);
    // The config still parses and references only existing nodes.
    expect(() => parse(result.content)).not.toThrow();
    expect(result.warnings.some((w) => w.includes('chain:F-to-B') && w.includes('后端'))).toBe(true);
  });

  it('scrubs a broken chain from another group’s members (DIRECT fallback when emptied)', async () => {
    const wrap = makeGroup({
      name: 'chain:F-to-B',
      type: 'select',
      proxies: ['B-GONE'],
      'dialer-proxy': 'F',
      rank: 30,
    });
    const mixed = makeGroup({
      name: 'MyGroup',
      type: 'select',
      proxies: ['chain:F-to-B', 'F'],
      rank: 10,
    });
    const onlyBroken = makeGroup({
      name: 'OnlyBroken',
      type: 'select',
      proxies: ['chain:F-to-B'],
      rank: 20,
    });
    const result = await resolveConfig(BASE_WITH_F, [], [], [wrap, mixed, onlyBroken], [], {});

    const doc = parse(result.content) as {
      'proxy-groups': Array<Record<string, unknown>>;
    };
    const my = doc['proxy-groups'].find((g) => g.name === 'MyGroup');
    expect(my?.proxies).toEqual(['F']); // broken chain removed, F kept
    const only = doc['proxy-groups'].find((g) => g.name === 'OnlyBroken');
    expect(only?.proxies).toEqual(['DIRECT']); // emptied → kept valid
    // No group references the pruned chain anymore.
    expect(result.content).not.toContain('chain:F-to-B');
    expect(result.warnings.some((w) => w.includes('MyGroup'))).toBe(true);
  });

  it('drops a rule whose policy points at a broken chain', async () => {
    const wrap = makeGroup({
      name: 'chain:F-to-B',
      type: 'select',
      proxies: ['B-GONE'],
      'dialer-proxy': 'F',
    });
    const rule = makeRule({ type: 'DOMAIN-SUFFIX', value: 'openai.com', policy: 'chain:F-to-B' });
    const result = await resolveConfig(BASE_WITH_F, [rule], [], [wrap], [], {});

    expect(result.content).not.toContain('chain:F-to-B');
    expect(
      result.warnings.some((w) => w.includes('chain:F-to-B') && w.includes('规则')),
    ).toBe(true);
  });

  it('clones a wrap whose backend is a subscription-injected node (plain object)', async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'US-Frontier', server: 'us.example' }]),
      proxyCount: 1,
    });
    const wrap = makeGroup({
      name: 'chain:pool-to-US-Frontier',
      type: 'select',
      proxies: ['US-Frontier'], // injected node, not a base literal
      'dialer-proxy': 'pool:US',
    });
    const result = await resolveConfig(
      BASE_WITH_MARKER,
      [],
      [makeSub({ name: 'a' })],
      [wrap],
      [],
      {},
    );

    const doc = parse(result.content) as {
      proxies: Array<Record<string, unknown>>;
      'proxy-groups'?: Array<Record<string, unknown>>;
    };
    const clone = doc.proxies.find((p) => p.name === 'chain:pool-to-US-Frontier');
    // The injected backend was cloned into proxies with its config + dialer-proxy…
    expect(clone).toBeTruthy();
    expect(clone?.['dialer-proxy']).toBe('pool:US');
    expect(clone?.server).toBe('us.example');
    // …and is NOT left behind as a proxy-group.
    const asGroup = (doc['proxy-groups'] ?? []).find(
      (g) => g.name === 'chain:pool-to-US-Frontier',
    );
    expect(asGroup).toBeFalsy();
  });

  it('warns and skips a wrap whose backend is not a concrete node', async () => {
    const wrap = makeGroup({
      name: 'chain:F-to-ghost',
      type: 'select',
      proxies: ['ghost'],
      'dialer-proxy': '直连',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [wrap], [], {});
    expect(result.warnings.some((w) => w.includes('无法克隆'))).toBe(true);
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

  it("single-sub binding lists the bound sub's nodes as proxies", async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }, { name: 'JP-01' }]),
      proxyCount: 2,
    });
    const sub = makeSub({ name: 'air-a' });
    const g = makeGroup({
      name: 'air-a-only',
      kind: 'single-sub',
      bound_subscription_id: sub.id,
      type: 'select',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {});
    // The bound sub's surviving node names are listed directly as proxies —
    // no prefix-derived filter, no include-all-proxies.
    expect(result.content).toMatch(/name: air-a-only[^]*proxies:[^]*HK-01[^]*JP-01/);
    expect(result.content).not.toContain('include-all-proxies: true');
    expect(result.content).not.toMatch(/filter: \^/);
  });

  it('single-sub warns when the bound sub has no surviving nodes', async () => {
    // Bound to a sub that injects nothing → group left without injected proxies.
    resolveSubMock.mockResolvedValueOnce({
      proxies: [],
      proxyCount: 0,
    });
    const sub = makeSub({ name: 'air-empty' });
    const g = makeGroup({
      name: 'sub-empty',
      kind: 'single-sub',
      bound_subscription_id: sub.id,
      type: 'select',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {});
    expect(result.warnings.some((w) => w.includes('air-empty') && w.includes('无可用节点'))).toBe(
      true,
    );
    // P0-2: render final defense — the group falls back to [DIRECT] so the
    // config stays mihomo-loadable (never an empty / stale proxies list).
    expect(result.content).toContain('name: sub-empty');
    const parsed = parse(result.content) as {
      'proxy-groups': Array<{ name: string; proxies: string[] }>;
    };
    expect(parsed['proxy-groups'].find((x) => x.name === 'sub-empty')?.proxies).toEqual(['DIRECT']);
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

  it("single-sub group proxies equal exactly the bound sub's injected node names, order preserved", async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'N-1' }, { name: 'N-2' }, { name: 'N-3' }]),
      proxyCount: 3,
    });
    const sub = makeSub({ name: 'ordered' });
    const g = makeGroup({
      name: 'ordered-only',
      kind: 'single-sub',
      bound_subscription_id: sub.id,
      type: 'select',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {});
    // nodesBySub is the authoritative per-sub attribution the binding reads from.
    expect(result.nodesBySub['ordered']).toEqual(['N-1', 'N-2', 'N-3']);
    // The rendered group's proxies are exactly that list, in order.
    const m = result.content.match(
      /name: ordered-only[^]*?proxies:\n([^]*?)(?:\n  - name:|\nrules:|\n[a-z])/,
    );
    expect(m).not.toBeNull();
    const order = ['N-1', 'N-2', 'N-3'].map((n) => result.content.indexOf(`- ${n}`));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  // Legacy collection-scope kind is gone (kind taxonomy 砍到 5 个). A group
  // that still carries a bound_collection_id (legacy data) keeps the binding
  // honoured at render — verify that route still works.
  it('legacy bound_collection_id auto-fills proxies from member-sub nodes', async () => {
    resolveSubMock
      .mockResolvedValueOnce({
        proxies: providerProxies([{ name: 'HK-01' }, { name: 'HK-02' }]),
        proxyCount: 2,
      })
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'JP-01' }]), proxyCount: 1 });
    const subA = makeSub({ name: 'air-a' });
    const subB = makeSub({ name: 'air-b' });
    const col: Collection = {
      id: crypto.randomUUID(),
      name: 'asia',
      slug: 'asia',
      enabled: true,
      type: 'select',
      subscription_ids: [subA.id, subB.id],
      subscription_tags: [],
      operators: [],
    } as Collection;
    const g = makeGroup({
      name: 'asia-scope',
      kind: 'manual',
      bound_collection_id: col.id,
      type: 'select',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [subA, subB], [g], [], {
      collections: [col],
    });
    expect(result.content).toMatch(/name: asia-scope[^]*proxies:[^]*HK-01[^]*HK-02[^]*JP-01/);
  });

  it('non-bound presets (filter / manual / all) render their fields verbatim', async () => {
    // kind only labels the form intent — these groups render their explicit
    // fields verbatim, no special resolve-time transformation.
    const g = makeGroup({
      name: 'HK',
      kind: 'filter',
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

describe('resolveConfig — profile binding (boundSource)', () => {
  it('restricts injection to one sub when source is { subscription }', async () => {
    // Only sub-a should be fetched; sub-b is filtered out before resolution.
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-A' }, { name: 'JP-A' }]),
      proxyCount: 2,
    });
    const a = makeSub({ name: 'sub-a' });
    const b = makeSub({ name: 'sub-b' });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [a, b], [], [], {
      boundSource: { type: 'subscription', id: a.id },
    });
    expect(result.nodeNames).toEqual(['直连', 'HK-A', 'JP-A']);
    expect(result.subscriptions.map((s) => s.name)).toEqual(['sub-a']);
    expect(resolveSubMock).toHaveBeenCalledTimes(1);
  });

  it('expands a collection source to its member subs', async () => {
    // Collection binds sub-a + sub-c; sub-b is excluded.
    resolveSubMock
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'HK-A' }]), proxyCount: 1 })
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'US-C' }]), proxyCount: 1 });
    const a = makeSub({ name: 'sub-a' });
    const b = makeSub({ name: 'sub-b' });
    const c = makeSub({ name: 'sub-c' });
    const col = {
      id: crypto.randomUUID(),
      name: 'pool',
      slug: 'pool',
      enabled: true,
      type: 'select' as const,
      subscription_ids: [a.id, c.id],
      subscription_tags: [],
      operators: [],
    };
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [a, b, c], [], [], {
      collections: [col],
      boundSource: { type: 'collection', id: col.id },
    });
    expect(result.nodeNames).toEqual(['直连', 'HK-A', 'US-C']);
    expect(result.subscriptions.map((s) => s.name)).toEqual(['sub-a', 'sub-c']);
  });

  it("applies the bound collection's operators to the merged member union", async () => {
    // Collection binds sub-a + sub-c; a drop filter removes every US-* node,
    // and a rename rewrites HK- → 香港-, applied over the merged union.
    resolveSubMock
      .mockResolvedValueOnce({
        proxies: providerProxies([{ name: 'HK-A' }, { name: 'US-A' }]),
        proxyCount: 2,
      })
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'US-C' }]), proxyCount: 1 });
    const a = makeSub({ name: 'sub-a' });
    const c = makeSub({ name: 'sub-c' });
    const col = {
      id: crypto.randomUUID(),
      name: 'pool',
      slug: 'pool',
      enabled: true,
      type: 'select' as const,
      subscription_ids: [a.id, c.id],
      subscription_tags: [],
      operators: [
        { kind: 'filter-regex' as const, id: 'op-drop-us', mode: 'drop' as const, pattern: '^US-' },
        {
          kind: 'rename-regex' as const,
          id: 'op-rename-hk',
          pattern: '^HK-',
          replacement: '香港-',
        },
      ],
    };
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [a, c], [], [], {
      collections: [col],
      boundSource: { type: 'collection', id: col.id },
    });
    // US-A and US-C dropped; HK-A renamed to 香港-A.
    expect(result.nodeNames).toEqual(['直连', '香港-A']);
    expect(result.content).toContain('香港-A');
    expect(result.content).not.toContain('US-A');
    expect(result.content).not.toContain('US-C');
  });

  it('a dangling collection source injects nothing and warns', async () => {
    const a = makeSub({ name: 'sub-a' });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [a], [], [], {
      collections: [],
      boundSource: { type: 'collection', id: crypto.randomUUID() },
    });
    expect(result.nodeNames).toEqual(['直连']);
    expect(result.warnings.some((w) => w.includes('绑定的聚合订阅不存在'))).toBe(true);
  });

  it('injects nothing when source is { none } (unbound profile)', async () => {
    const a = makeSub({ name: 'sub-a' });
    const b = makeSub({ name: 'sub-b' });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [a, b], [], [], {
      boundSource: { type: 'none' },
    });
    expect(result.nodeNames).toEqual(['直连']);
    expect(resolveSubMock).not.toHaveBeenCalled();
  });

  it('falls back to all enabled when boundSource is undefined (pre-Profile callers)', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'HK' }]), proxyCount: 1 })
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'US' }]), proxyCount: 1 });
    const a = makeSub({ name: 'sub-a' });
    const b = makeSub({ name: 'sub-b' });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [a, b], [], [], {});
    expect(result.nodeNames).toEqual(['直连', 'HK', 'US']);
  });
});

/* ─── P0-2 / P0-4 render final-defense (config must always load) ─────── */

describe('resolveConfig — render must always be mihomo-loadable', () => {
  it('P0-2: a single-sub group whose bound sub has no live nodes falls back to [DIRECT], not stale/empty', async () => {
    // Sub 'air' resolves to zero nodes this render.
    resolveSubMock.mockResolvedValueOnce({ proxies: providerProxies([]), proxyCount: 0 });
    const sub = makeSub({ name: 'air' });
    const g = makeGroup({
      name: '机场A',
      type: 'select',
      kind: 'single-sub',
      bound_subscription_id: sub.id,
      proxies: ['旧节点-会消失'], // stale names that would dangle
      rank: 10,
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {});
    const parsed = parse(result.content) as { 'proxy-groups': Array<{ name: string; proxies: string[] }> };
    const group = parsed['proxy-groups'].find((x) => x.name === '机场A');
    expect(group?.proxies).toEqual(['DIRECT']);
    expect(result.content).not.toContain('旧节点-会消失');
    expect(result.warnings.some((w) => w.includes('DIRECT'))).toBe(true);
  });

  it('P0-2: an empty manual group ([] members, no include-all) falls back to [DIRECT]', async () => {
    const g = makeGroup({ name: '空组', type: 'select', kind: 'manual', proxies: [], rank: 10 });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {});
    const parsed = parse(result.content) as { 'proxy-groups': Array<{ name: string; proxies: string[] }> };
    const group = parsed['proxy-groups'].find((x) => x.name === '空组');
    expect(group?.proxies).toEqual(['DIRECT']);
    // never emit an empty proxies list
    expect(result.content).not.toMatch(/proxies:\s*\[\s*\]/);
    expect(result.warnings.some((w) => w.includes('DIRECT'))).toBe(true);
  });

  it('P0-2: an include-all group with no explicit proxies is left untouched (has a member source)', async () => {
    const g = makeGroup({
      name: '全部',
      type: 'url-test',
      kind: 'all',
      'include-all-proxies': true,
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      rank: 10,
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {});
    // include-all is a valid member source → no DIRECT injection for this group
    expect(result.warnings.some((w) => w.includes('全部') && w.includes('DIRECT'))).toBe(false);
  });

  it('P0-4: a RULE-SET rule with no RULE-PROVIDERS marker warns and does NOT report applied', async () => {
    const provider: RuleSet = {
      id: crypto.randomUUID(),
      name: 'ads',
      source: 'remote',
      behavior: 'domain',
      format: 'yaml',
      url: 'https://example.com/ads.yaml',
      interval: 86400,
      content: '',
      updated_at: 0,
    } as RuleSet;
    const rule: Rule = {
      id: crypto.randomUUID(),
      anchor: 'manual',
      type: 'RULE-SET',
      value: 'ads',
      policy: 'REJECT',
      rank: 1,
      source: 'manual',
      added_at: 0,
      updated_at: 0,
    } as Rule;
    // BASE_WITH_LITERAL has an ANCHOR:manual but NO `# === RULE-PROVIDERS ===`.
    const result = await resolveConfig(BASE_WITH_LITERAL, [rule], [], [], [], {
      providers: [provider],
    });
    expect(result.ruleProvidersApplied).toEqual([]);
    expect(result.warnings.some((w) => w.includes('RULE-PROVIDERS'))).toBe(true);
    // The rendered config must not carry an undeclared RULE-SET reference silently claimed as fine.
    expect(result.content).toContain('RULE-SET,ads,REJECT');
    expect(result.content).not.toContain('rule-providers:');
  });

  it('P0-5: a collection whose operator throws degrades to a warning instead of 500-ing the render', async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-01' }]),
      proxyCount: 1,
    });
    const sub = makeSub({ name: 'air' });
    // A legacy/hand-crafted rename-regex with an invalid pattern (schema would
    // reject it today, but pre-guard data can carry it). `new RegExp('(')`
    // throws inside applyOperators.
    const col: Collection = {
      id: crypto.randomUUID(),
      name: '聚合',
      subscription_ids: [sub.id],
      subscription_tags: [],
      operators: [{ id: 'op1', kind: 'rename-regex', pattern: '(', replacement: '' }],
      updated_at: 0,
    } as unknown as Collection;

    let result: Awaited<ReturnType<typeof resolveConfig>> | undefined;
    await expect(
      (async () => {
        result = await resolveConfig(BASE_WITH_MARKER, [], [sub], [], [], {
          collections: [col],
          boundSource: { type: 'collection', id: col.id },
        });
      })(),
    ).resolves.not.toThrow();
    expect(result!.warnings.some((w) => w.includes('流水线执行失败'))).toBe(true);
    // The unprocessed node still made it in — degrade, don't drop everything.
    expect(result!.nodeNames).toContain('HK-01');
  });
});
