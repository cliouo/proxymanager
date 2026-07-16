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
import { MAX_PROXY_NODES } from '@/lib/proxies/mihomoProxyValidator';
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

  it('rejects a multi-subscription union whose base-inclusive final list exceeds the limit', async () => {
    const firstCount = Math.floor(MAX_PROXY_NODES / 2) + 1;
    const makeMany = (prefix: string, count: number): Record<string, unknown>[] =>
      Array.from({ length: count }, (_, index) => ({
        name: `${prefix}-${index}`,
        type: 'ss',
        server: 'edge.invalid',
        port: 8388,
        cipher: 'aes-128-gcm',
        password: 'FAKE_ONLY',
      }));
    resolveSubMock
      .mockResolvedValueOnce({ proxies: makeMany('A', firstCount), proxyCount: firstCount })
      .mockResolvedValueOnce({
        proxies: makeMany('B', MAX_PROXY_NODES - firstCount),
        proxyCount: MAX_PROXY_NODES - firstCount,
      });

    await expect(
      resolveConfig(
        BASE_WITH_LITERAL,
        [],
        [makeSub({ name: 'first' }), makeSub({ name: 'second' })],
        [],
        [],
        {},
      ),
    ).rejects.toThrow(`Proxy node count ${MAX_PROXY_NODES + 1} exceeds limit ${MAX_PROXY_NODES}`);
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
  - MATCH,DIRECT
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

  it('rejects an unrepresentable multi-member chained proxy instead of emitting a no-op group', async () => {
    const wrap = makeGroup({
      name: 'chain:ambiguous',
      type: 'select',
      proxies: ['直连', 'other'],
      'dialer-proxy': 'front',
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [wrap], [], {})).rejects.toThrow(
      /chained proxy must have exactly one backend member/,
    );
  });

  it('rejects a chained-proxy name collision instead of leaving a duplicate group', async () => {
    const wrap = makeGroup({
      name: '直连',
      type: 'select',
      proxies: ['直连'],
      'dialer-proxy': 'front',
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [wrap], [], {})).rejects.toThrow(
      /chained proxy name collides with an existing proxy/,
    );
  });

  it('rejects a dialer-proxy cycle split across base and subscription nodes', async () => {
    const base = `mixed-port: 7890
proxies:
  - name: A
    type: ss
    server: a.invalid
    port: 443
    cipher: aes-128-gcm
    password: FAKE_ONLY
    dialer-proxy: B
rules:
  - MATCH,DIRECT
`;
    resolveSubMock.mockResolvedValueOnce({
      proxies: [
        {
          name: 'B',
          type: 'ss',
          server: 'b.invalid',
          port: 443,
          cipher: 'aes-128-gcm',
          password: 'FAKE_ONLY',
          'dialer-proxy': 'A',
        },
      ],
      proxyCount: 1,
    });

    await expect(
      resolveConfig(base, [], [makeSub({ name: 'cycle-source' })], [], [], {}),
    ).rejects.toThrow(/dependency cycle/);
  });

  it('rejects a dependency cycle split across a concrete proxy and proxy-group', async () => {
    const base = `mixed-port: 7890
proxies:
  - name: A
    type: ss
    server: a.invalid
    port: 443
    cipher: aes-128-gcm
    password: FAKE_ONLY
    dialer-proxy: G

# === PROXY-GROUPS ===

rules:
  - MATCH,DIRECT
`;
    const group = makeGroup({ name: 'G', proxies: ['A'] });
    await expect(resolveConfig(base, [], [], [group], [], {})).rejects.toThrow(
      /proxy and proxy-group dependencies contain a cycle/i,
    );
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
      'exclude-filter': 'foo`bar',
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
    expect(poolGroup?.['exclude-filter']).toBe('foo`bar`^chain:pool-to-B$');
    expect(poolGroup?.['empty-fallback']).toBe('REJECT');
  });

  it('rejects overwriting a backend dialer-proxy while realizing a chain wrap', async () => {
    const base = BASE_WITH_F.replace('password: pw', 'password: pw\n    dialer-proxy: upstream');
    const wrap = makeGroup({
      name: 'chain:double-hop',
      type: 'select',
      proxies: ['F'],
      'dialer-proxy': 'DIRECT',
    });
    await expect(resolveConfig(base, [], [], [wrap], [], {})).rejects.toThrow(
      /already has dialer-proxy; implicit multi-hop overwrite is forbidden/i,
    );
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

  it('fails closed when a chain wrap backend node is missing', async () => {
    // Backend "B-GONE" doesn't exist in proxies (e.g. it was renamed away).
    const wrap = makeGroup({
      name: 'chain:F-to-B',
      type: 'select',
      proxies: ['B-GONE'],
      'dialer-proxy': 'F',
    });
    await expect(resolveConfig(BASE_WITH_F, [], [], [wrap], [], {})).rejects.toThrow(
      /backend is missing or is not a concrete proxy/i,
    );
  });

  it('does not silently scrub a broken chain from other groups', async () => {
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
    await expect(
      resolveConfig(BASE_WITH_F, [], [], [wrap, mixed, onlyBroken], [], {}),
    ).rejects.toThrow(/backend is missing or is not a concrete proxy/i);
  });

  it('does not silently drop a rule whose policy points at a broken chain', async () => {
    const wrap = makeGroup({
      name: 'chain:F-to-B',
      type: 'select',
      proxies: ['B-GONE'],
      'dialer-proxy': 'F',
    });
    const rule = makeRule({ type: 'DOMAIN-SUFFIX', value: 'openai.com', policy: 'chain:F-to-B' });
    await expect(resolveConfig(BASE_WITH_F, [rule], [], [wrap], [], {})).rejects.toThrow(
      /backend is missing or is not a concrete proxy/i,
    );
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
    const front = makeGroup({ name: 'pool:US', type: 'select', proxies: ['DIRECT'] });
    const result = await resolveConfig(
      BASE_WITH_MARKER,
      [],
      [makeSub({ name: 'a' })],
      [front, wrap],
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
    const asGroup = (doc['proxy-groups'] ?? []).find((g) => g.name === 'chain:pool-to-US-Frontier');
    expect(asGroup).toBeFalsy();
  });

  it('fails closed when a wrap backend is not a concrete node', async () => {
    const wrap = makeGroup({
      name: 'chain:F-to-ghost',
      type: 'select',
      proxies: ['ghost'],
      'dialer-proxy': '直连',
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [wrap], [], {})).rejects.toThrow(
      /backend is missing or is not a concrete proxy/i,
    );
  });

  it('renders groups in rank order, ties broken by name', async () => {
    const a = makeGroup({ name: 'z-low', rank: 5, proxies: ['DIRECT'] });
    const b = makeGroup({ name: 'a-high', rank: 100, proxies: ['DIRECT'] });
    const c = makeGroup({ name: 'b-tied', rank: 50, proxies: ['DIRECT'] });
    const d = makeGroup({ name: 'a-tied', rank: 50, proxies: ['DIRECT'] });

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
    const g = makeGroup({
      name: 'X',
      template_id: tpl.id,
      interval: 9999,
      type: 'url-test',
      proxies: ['DIRECT'],
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [tpl], {});
    expect(result.content).toContain('interval: 9999');
    expect(result.content).not.toContain('interval: 600');
  });

  it('fails closed when template_id is dangling', async () => {
    const g = makeGroup({
      name: 'X',
      type: 'url-test',
      template_id: '00000000-0000-0000-0000-000000000000',
      url: 'http://probe',
      proxies: ['DIRECT'],
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {})).rejects.toThrow(
      /template is missing/i,
    );
  });

  it('fails closed when hash has groups but the base lacks the marker', async () => {
    const g = makeGroup({ name: 'orphan', proxies: ['DIRECT'] });
    await expect(resolveConfig(BASE_WITH_LITERAL, [], [], [g], [], {})).rejects.toThrow(
      /PROXY-GROUPS/,
    );
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

  it('single-sub fails closed when the bound sub has no surviving nodes', async () => {
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
    await expect(resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {})).rejects.toThrow(
      /single-sub proxy-group has no surviving nodes/i,
    );
  });

  it('single-sub fails closed when bound subscription id is dangling', async () => {
    const g = makeGroup({
      name: 'dangling',
      kind: 'single-sub',
      bound_subscription_id: '00000000-0000-0000-0000-000000000000',
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {})).rejects.toThrow(
      /single-sub proxy-group binding is missing/i,
    );
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
      proxies: ['DIRECT', '直连'],
      filter: 'HK',
      'exclude-filter': 'expire',
      'exclude-type': 'Direct|Reject',
      'include-all-proxies': true,
      'disable-udp': true,
      hidden: false,
      strategy: 'round-robin',
      url: 'http://probe',
      interval: 300,
      'expected-status': '200',
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

  it('fails closed when a collection operator creates an invalid node', async () => {
    resolveSubMock.mockResolvedValueOnce({
      proxies: providerProxies([{ name: 'HK-A' }]),
      proxyCount: 1,
    });
    const sub = makeSub({ name: 'sub-a' });
    const col: Collection = {
      id: crypto.randomUUID(),
      name: 'pool',
      slug: 'pool',
      enabled: true,
      type: 'select',
      subscription_ids: [sub.id],
      subscription_tags: [],
      operators: [{ kind: 'rename-regex', id: 'empty-name', pattern: '.+', replacement: '' }],
    };

    await expect(
      resolveConfig(BASE_WITH_LITERAL, [], [sub], [], [], {
        collections: [col],
        boundSource: { type: 'collection', id: col.id },
      }),
    ).rejects.toThrow(/field "name"/i);
  });

  it('still applies cross-source first-writer-wins after a valid collection pipeline', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'SHARED' }]), proxyCount: 1 })
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'SHARED' }]), proxyCount: 1 });
    const a = makeSub({ name: 'sub-a' });
    const b = makeSub({ name: 'sub-b' });
    const col: Collection = {
      id: crypto.randomUUID(),
      name: 'pool',
      slug: 'pool',
      enabled: true,
      type: 'select',
      subscription_ids: [a.id, b.id],
      subscription_tags: [],
      operators: [{ kind: 'set-prop', id: 'udp', udp: true }],
    };

    const result = await resolveConfig(BASE_WITH_LITERAL, [], [a, b], [], [], {
      collections: [col],
      boundSource: { type: 'collection', id: col.id },
    });

    expect(result.nodeNames.filter((name) => name === 'SHARED')).toHaveLength(1);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toMatchObject({ name: 'SHARED', keptFrom: 'sub-a' });
  });

  it('preserves per-sub provenance through collection renames for two single-sub groups', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'A-01' }]), proxyCount: 1 })
      .mockResolvedValueOnce({ proxies: providerProxies([{ name: 'B-01' }]), proxyCount: 1 });
    const a = makeSub({ name: 'sub-a' });
    const b = makeSub({ name: 'sub-b' });
    const col: Collection = {
      id: crypto.randomUUID(),
      name: 'renamed-pool',
      slug: 'renamed-pool',
      enabled: true,
      type: 'select',
      subscription_ids: [a.id, b.id],
      subscription_tags: [],
      operators: [{ kind: 'rename-regex', id: 'prefix', pattern: '^', replacement: 'renamed-' }],
    };
    const groupA = makeGroup({
      name: 'only-a',
      kind: 'single-sub',
      bound_subscription_id: a.id,
      rank: 1,
    });
    const groupB = makeGroup({
      name: 'only-b',
      kind: 'single-sub',
      bound_subscription_id: b.id,
      rank: 2,
    });

    const result = await resolveConfig(BASE_WITH_MARKER, [], [a, b], [groupA, groupB], [], {
      collections: [col],
      boundSource: { type: 'collection', id: col.id },
    });
    expect(result.nodesBySub).toEqual({
      'sub-a': ['renamed-A-01'],
      'sub-b': ['renamed-B-01'],
    });
    const parsed = parse(result.content) as {
      'proxy-groups': Array<{ name: string; proxies: string[] }>;
    };
    expect(parsed['proxy-groups'].find((group) => group.name === 'only-a')?.proxies).toEqual([
      'renamed-A-01',
    ]);
    expect(parsed['proxy-groups'].find((group) => group.name === 'only-b')?.proxies).toEqual([
      'renamed-B-01',
    ]);
  });

  it('a dangling profile-bound collection fails closed', async () => {
    const a = makeSub({ name: 'sub-a' });
    await expect(
      resolveConfig(BASE_WITH_LITERAL, [], [a], [], [], {
        collections: [],
        boundSource: { type: 'collection', id: crypto.randomUUID() },
      }),
    ).rejects.toThrow(/profile-bound collection is missing/i);
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
  const withLiteralRules = (lines: string[]) =>
    BASE_WITH_LITERAL.replace(
      '  # === ANCHOR: manual ===\n  - MATCH,默认',
      lines.map((line) => `  - ${line}`).join('\n'),
    );

  it('accepts the portable fixed rule payload/param/logic subset', async () => {
    const base = withLiteralRules([
      'DOMAIN,example.com,DIRECT',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'DST-PORT,80/443/1000-2000,DIRECT',
      'DSCP,0/63,DIRECT',
      'NETWORK,TCP,DIRECT',
      'DOMAIN-REGEX,foo(?=bar),DIRECT',
      'AND,((NETWORK,TCP),(DST-PORT,443)),DIRECT',
      'AND,((AND,(DOMAIN,baidu.com),(NETWORK,TCP)),(NETWORK,TCP),(DST-PORT,10001-65535)),DIRECT',
      'NOT,((DOMAIN,blocked.example)),DIRECT',
    ]);
    await expect(resolveConfig(base, [], [], [], [], {})).resolves.toMatchObject({
      content: expect.stringContaining('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'),
    });
  });

  it.each([
    'IP-CIDR,not-a-cidr,DIRECT',
    'IP-CIDR,192.0.2.0/024,DIRECT',
    'IP-CIDR6,1.2.3.4::/64,DIRECT',
    'DST-PORT,65536,DIRECT',
    'NETWORK,QUIC,DIRECT',
    'DOMAIN,foo,DIRECT,ignored',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve,no-resolve',
    'NOT,((DOMAIN,a),(DOMAIN,b)),DIRECT',
    'AND,(DOMAIN,a),DIRECT',
    'DOMAIN-REGEX,[],DIRECT',
    'DOMAIN-REGEX,(a|A)+$,DIRECT',
    'DOMAIN-REGEX,(K|KK)+$,DIRECT',
    'DOMAIN-REGEX,(ß|\\u1E9Eß)+$,DIRECT',
    'DOMAIN-REGEX,(K|[℀-∀]K)+$,DIRECT',
    'DOMAIN-REGEX,(K|[\\u2100-\\u2200]K)+$,DIRECT',
    'DOMAIN-REGEX,^foo, bar$,DIRECT',
    'AND,((DOMAIN-REGEX,foo, bar),(NETWORK,TCP)),DIRECT',
    'SUB-RULE,(DOMAIN-REGEX,foo, bar),missing-sub-rule',
    'UID,1000,DIRECT',
  ])('rejects invalid or silently ignored final rule syntax: %s', async (line) => {
    await expect(resolveConfig(withLiteralRules([line]), [], [], [], [], {})).rejects.toThrow();
  });

  it('does not normalize Unicode whitespace around a final rule policy', async () => {
    await expect(
      resolveConfig(
        withLiteralRules(['DOMAIN,example.com,\u00a0DIRECT\u00a0']),
        [],
        [],
        [],
        [],
        {},
      ),
    ).rejects.toThrow(/rule policy is missing/i);
  });

  it('detects a missing RULE-SET whose literal provider name contains parentheses', async () => {
    await expect(
      resolveConfig(withLiteralRules(['RULE-SET,ghost(name),DIRECT']), [], [], [], [], {}),
    ).rejects.toThrow(/rule-set reference is (?:missing|absent)/i);
  });

  it('does not treat RULE-SET-looking text inside a regex as a provider reference', async () => {
    const dormantUrl = 'https://example.invalid/should-stay-dormant.yaml';
    const provider: RuleSet = {
      id: crypto.randomUUID(),
      name: 'ghost',
      source: 'remote',
      behavior: 'domain',
      format: 'yaml',
      url: dormantUrl,
      interval: 86400,
      content: '',
      updated_at: 0,
    } as RuleSet;
    const base = withLiteralRules(['DOMAIN-REGEX,^(RULE-SET,ghost)$,DIRECT']).replace(
      'rules:',
      '# === RULE-PROVIDERS ===\nrules:',
    );
    const result = await resolveConfig(base, [], [], [], [], { providers: [provider] });
    expect(result.content).toContain('RULE-SET,ghost');
    expect(result.ruleProvidersApplied).toEqual([]);
    expect(result.content).not.toContain(dormantUrl);
  });

  it('rejects a final concrete proxy whose dialer-proxy target is absent', async () => {
    const base = [
      'mixed-port: 7890',
      'proxies:',
      '  - name: backend',
      '    type: socks5',
      '    server: edge.invalid',
      '    port: 1080',
      '    dialer-proxy: missing-front',
      'rules:',
      '  - MATCH,DIRECT',
    ].join('\n');

    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(/dialer-proxy target/i);
  });

  it('rejects a managed group with a dangling explicit member', async () => {
    const group = makeGroup({ name: 'broken', proxies: ['missing-node'] });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [group], [], {})).rejects.toThrow(
      /group member is missing/i,
    );
  });

  it('rejects a base literal group with a dangling explicit member', async () => {
    const base = [
      'mixed-port: 7890',
      'proxy-groups:',
      '  - name: broken',
      '    type: select',
      '    proxies: [missing-node]',
      'rules:',
      '  - MATCH,DIRECT',
    ].join('\n');

    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(
      /group member is missing/i,
    );
  });

  it('rejects a managed group whose use entry names no final proxy-provider', async () => {
    const group = makeGroup({ name: 'broken-provider', use: ['missing-provider'] });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [group], [], {})).rejects.toThrow(
      /group provider is missing/i,
    );
  });

  it('rejects a final rule policy that names neither a proxy, group, nor builtin', async () => {
    const rule: Rule = {
      id: crypto.randomUUID(),
      anchor: 'manual',
      type: 'DOMAIN',
      value: 'example.invalid',
      policy: 'missing-policy',
      rank: 1,
      source: 'manual',
      added_at: 0,
      updated_at: 0,
    } as Rule;
    await expect(resolveConfig(BASE_WITH_MARKER, [rule], [], [], [], {})).rejects.toThrow(
      /rule policy is missing/i,
    );
  });

  it('rejects the relay proxy-group type removed by fixed Mihomo', async () => {
    const relay = makeGroup({
      name: 'legacy-relay',
      type: 'relay' as never,
      proxies: ['DIRECT'],
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [relay], [], {})).rejects.toThrow(
      /group type is unsupported/i,
    );
  });

  it('rejects a legacy managed regex option before comma rendering can change its policy', async () => {
    const rule = makeRule({
      type: 'DOMAIN-REGEX',
      value: 'foo',
      policy: 'REJECT',
      options: ['DIRECT'],
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [rule], [], [], [], {})).rejects.toThrow();
  });

  it.each(['[]', '[^]'])('rejects regexp2-incompatible final rule regex %s', async (value) => {
    const rule = makeRule({ type: 'DOMAIN-REGEX', value, policy: 'DIRECT' });
    await expect(resolveConfig(BASE_WITH_MARKER, [rule], [], [], [], {})).rejects.toThrow();
  });

  it('accepts an actual GLOBAL group and builtin final policy targets', async () => {
    const global = makeGroup({ name: 'GLOBAL', proxies: ['DIRECT'] });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [global], [], {})).resolves.toMatchObject({
      content: expect.stringContaining('name: GLOBAL'),
    });
  });

  it('a single-sub group whose bound sub has no live nodes fails closed instead of using stale/DIRECT members', async () => {
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
    await expect(resolveConfig(BASE_WITH_MARKER, [], [sub], [g], [], {})).rejects.toThrow(
      /single-sub proxy-group has no surviving nodes/i,
    );
  });

  it('an empty manual group fails closed instead of silently bypassing via DIRECT', async () => {
    const g = makeGroup({ name: '空组', type: 'select', kind: 'manual', proxies: [], rank: 10 });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {})).rejects.toThrow(
      /no final member source/i,
    );
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
    const parsed = parse(result.content) as {
      'proxy-groups': Array<{ name: string; 'empty-fallback'?: string }>;
    };
    expect(parsed['proxy-groups'].find((x) => x.name === '全部')?.['empty-fallback']).toBe(
      'REJECT',
    );
  });

  it('preserves an explicit concrete empty-fallback on a dynamic group', async () => {
    const g = makeGroup({
      name: '全部',
      type: 'select',
      kind: 'all',
      'include-all-proxies': true,
      'empty-fallback': 'DIRECT',
    });
    const result = await resolveConfig(BASE_WITH_MARKER, [], [], [g], [], {});
    const parsed = parse(result.content) as {
      'proxy-groups': Array<{ name: string; 'empty-fallback'?: string }>;
    };
    expect(parsed['proxy-groups'][0]['empty-fallback']).toBe('DIRECT');
  });

  it('rejects empty-fallback targets that resolve to a proxy-group', async () => {
    const target = makeGroup({ name: 'other-group', proxies: ['DIRECT'], rank: 1 });
    const dynamic = makeGroup({
      name: 'dynamic',
      'include-all-proxies': true,
      'empty-fallback': 'other-group',
      rank: 2,
    });
    await expect(
      resolveConfig(BASE_WITH_MARKER, [], [], [target, dynamic], [], {}),
    ).rejects.toThrow(/empty-fallback is invalid/i);
  });

  it('rejects invalid and unsafe final group regexes', async () => {
    for (const filter of ['(', '^(a+)+$', '^\\w+$', '(?i)(K|KK)+$', '(?i)(ß|\\u1E9Eß)+$']) {
      const group = makeGroup({
        name: `bad-${filter.length}`,
        'include-all-proxies': true,
        filter,
      });
      await expect(resolveConfig(BASE_WITH_MARKER, [], [], [group], [], {})).rejects.toThrow(
        /filter is unsafe or invalid/i,
      );
    }
  });

  it('rejects comma-separated exclude-type because fixed Mihomo splits only on pipe', async () => {
    const group = makeGroup({
      name: 'bad-exclude-type',
      proxies: ['DIRECT'],
      'exclude-type': 'Direct,Reject' as never,
    });
    await expect(resolveConfig(BASE_WITH_MARKER, [], [], [group], [], {})).rejects.toThrow(
      /exclude-type is invalid/i,
    );
  });

  it('P0-4: a RULE-SET rule with no RULE-PROVIDERS marker fails the render closed', async () => {
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
    await expect(
      resolveConfig(BASE_WITH_LITERAL, [rule], [], [], [], {
        providers: [provider],
      }),
    ).rejects.toThrow(/RULE-PROVIDERS/);
  });

  it('fails closed when an active RULE-SET references a provider absent from the library', async () => {
    const baseWithProviderMarker = BASE_WITH_MARKER.replace(
      '# === PROXY-GROUPS ===',
      '# === RULE-PROVIDERS ===\n# === PROXY-GROUPS ===',
    );
    const rule: Rule = {
      id: crypto.randomUUID(),
      anchor: 'manual',
      type: 'RULE-SET',
      value: 'ghost',
      policy: 'REJECT',
      rank: 1,
      source: 'manual',
      added_at: 0,
      updated_at: 0,
    } as Rule;

    await expect(resolveConfig(baseWithProviderMarker, [rule], [], [], [], {})).rejects.toThrow(
      /absent from the rule-set library/i,
    );
  });

  it('fails closed when base DNS references a rule-set absent from the library', async () => {
    const base = [
      'mixed-port: 7890',
      'dns:',
      '  nameserver-policy:',
      '    "rule-set:ghost":',
      '      - https://dns.example/dns-query',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  # === ANCHOR: manual ===',
      '  - MATCH,DIRECT',
    ].join('\n');

    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(
      /absent from the rule-set library/i,
    );
  });

  it('preserves a colon in a single DNS policy rule-set name and fails it closed', async () => {
    const provider: RuleSet = {
      id: crypto.randomUUID(),
      name: 'ads',
      source: 'remote',
      behavior: 'domain',
      format: 'yaml',
      url: 'https://example.invalid/ads.yaml',
      interval: 86400,
      content: '',
      updated_at: 0,
    } as RuleSet;
    const base = [
      'mixed-port: 7890',
      'dns:',
      '  nameserver-policy:',
      '    "rule-set:ads:ignored":',
      '      - https://dns.example/dns-query',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  - MATCH,DIRECT',
    ].join('\n');

    await expect(resolveConfig(base, [], [], [], [], { providers: [provider] })).rejects.toThrow(
      /absent from the rule-set library/i,
    );
  });

  it('does not treat a comment example as a final rule-set reference', async () => {
    const base = `${BASE_WITH_LITERAL}\n# Example only: rule-set:ghost\n`;

    await expect(resolveConfig(base, [], [], [], [], {})).resolves.toMatchObject({
      content: expect.stringContaining('MATCH,默认'),
    });
  });

  it('does not treat an embedded contextual rule-set substring as a provider reference', async () => {
    const base = BASE_WITH_LITERAL.replace(
      'rules:',
      ['sniffer:', '  force-domain:', '    - "foo-rule-set:ghost"', 'rules:'].join('\n'),
    );

    await expect(resolveConfig(base, [], [], [], [], {})).resolves.toMatchObject({
      ruleProvidersApplied: [],
    });
  });

  it.each([
    [
      'disabled root TUN',
      ['tun:', '  enable: false', '  auto-route: true', '  auto-redirect: true'],
    ],
    [
      'disabled root auto-redirect',
      ['tun:', '  enable: true', '  auto-route: true', '  auto-redirect: false'],
    ],
    [
      'disabled listener auto-redirect',
      ['listeners:', '  - name: dormant', '    type: tun', '    auto-redirect: false'],
    ],
  ])('does not require a dormant route-set provider for %s', async (_label, lines) => {
    const base = BASE_WITH_LITERAL.replace(
      'rules:',
      [...lines, `${lines[0] === 'tun:' ? '  ' : '    '}route-address-set: [ghost]`, 'rules:'].join(
        '\n',
      ),
    );

    await expect(resolveConfig(base, [], [], [], [], {})).resolves.toMatchObject({
      ruleProvidersApplied: [],
    });
  });

  it.each([
    ['root TUN', ['tun:', '  enable: true', '  auto-route: false', '  auto-redirect: true']],
    [
      'TUN listener',
      [
        'listeners:',
        '  - name: invalid',
        '    type: tun',
        '    auto-route: false',
        '    auto-redirect: true',
      ],
    ],
  ])('rejects %s auto-redirect with auto-route disabled', async (_label, lines) => {
    const base = BASE_WITH_LITERAL.replace('rules:', [...lines, 'rules:'].join('\n'));
    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(
      /auto-redirect requires auto-route/i,
    );
  });

  it('requires an active TUN route rule-set and enforces IP-CIDR behavior', async () => {
    const base = BASE_WITH_LITERAL.replace(
      'rules:',
      [
        'tun:',
        '  enable: true',
        // Root RawTun defaults auto-route to true.
        '  auto-redirect: true',
        '  route-address-set: [tun_routes]',
        '# === RULE-PROVIDERS ===',
        'rules:',
      ].join('\n'),
    );
    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(
      /absent from the rule-set library/i,
    );

    const classicalProvider: RuleSet = {
      id: crypto.randomUUID(),
      name: 'tun_routes',
      source: 'remote',
      behavior: 'classical',
      format: 'yaml',
      url: 'https://example.invalid/tun.yaml',
      interval: 86400,
      content: '',
      updated_at: 0,
    } as RuleSet;
    await expect(
      resolveConfig(base, [], [], [], [], { providers: [classicalProvider] }),
    ).rejects.toThrow(/TUN route requires an IP-CIDR rule-set/i);

    const ipProvider = { ...classicalProvider, behavior: 'ipcidr' as const };
    await expect(
      resolveConfig(base, [], [], [], [], { providers: [ipProvider] }),
    ).resolves.toMatchObject({ ruleProvidersApplied: ['tun_routes'] });
  });

  it.each([
    [
      'numeric listener booleans',
      [
        'listeners:',
        '  - name: weak-bools',
        '    type: tun',
        '    auto-route: 1',
        '    auto-redirect: 1',
      ],
      /TUN boolean field is mistyped/i,
    ],
    [
      'a numeric listener route-set name',
      [
        'listeners:',
        '  - name: weak-list',
        '    type: tun',
        '    auto-route: true',
        '    auto-redirect: true',
        '    route-address-set: [123]',
      ],
      /TUN route-set list is mistyped/i,
    ],
  ])('rejects fixed weak conversion for %s', async (_label, lines, error) => {
    const base = BASE_WITH_LITERAL.replace('rules:', [...lines, 'rules:'].join('\n'));
    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(error);
  });

  it.each([
    [
      'auto_redirect',
      [
        'listeners:',
        '  - name: alias-bool',
        '    type: tun',
        '    auto-route: true',
        '    auto_redirect: true',
        '    route-address-set: [ghost]',
      ],
    ],
    [
      'route_address_set',
      [
        'listeners:',
        '  - name: alias-list',
        '    type: tun',
        '    auto-route: true',
        '    auto-redirect: true',
        '    route_address_set: [ghost]',
      ],
    ],
    [
      'AUTO-REDIRECT',
      [
        'listeners:',
        '  - name: alias-case',
        '    type: tun',
        '    auto-route: true',
        '    AUTO-REDIRECT: true',
        '    route-address-set: [ghost]',
      ],
    ],
  ])('rejects a fixed weak TUN field alias: %s', async (_alias, lines) => {
    const base = BASE_WITH_LITERAL.replace('rules:', [...lines, 'rules:'].join('\n'));
    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(/noncanonical alias/i);
  });

  it.each(['', '   '])('fails closed on an active empty TUN route-set name: %j', async (name) => {
    const base = BASE_WITH_LITERAL.replace(
      'rules:',
      [
        'tun:',
        '  enable: true',
        '  auto-route: true',
        '  auto-redirect: true',
        `  route-address-set: [${JSON.stringify(name)}]`,
        '# === RULE-PROVIDERS ===',
        'rules:',
      ].join('\n'),
    );

    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(
      /absent from the rule-set library/i,
    );
  });

  it.each(['redir-host', undefined])(
    'ignores fake-ip-filter provider text outside fake-IP mode: %s',
    async (enhancedMode) => {
      const dnsLines = [
        'dns:',
        ...(enhancedMode ? [`  enhanced-mode: ${enhancedMode}`] : []),
        '  fake-ip-filter: ["rule-set:ghost"]',
      ];
      const base = BASE_WITH_LITERAL.replace('rules:', [...dnsLines, 'rules:'].join('\n'));

      await expect(resolveConfig(base, [], [], [], [], {})).resolves.toMatchObject({
        ruleProvidersApplied: [],
      });
    },
  );

  it('collects uppercase fake-IP rule mode exactly like fixed Mihomo', async () => {
    const base = BASE_WITH_LITERAL.replace(
      'rules:',
      [
        'dns:',
        '  enhanced-mode: FAKE-IP',
        '  fake-ip-filter-mode: RULE',
        '  fake-ip-filter:',
        '    - RULE-SET,ghost,fake-ip',
        '# === RULE-PROVIDERS ===',
        'rules:',
      ].join('\n'),
    );

    await expect(resolveConfig(base, [], [], [], [], {})).rejects.toThrow(
      /absent from the rule-set library/i,
    );
  });

  it('P0-5: a collection whose operator throws fails the render instead of using raw nodes', async () => {
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

    await expect(
      resolveConfig(BASE_WITH_MARKER, [], [sub], [], [], {
        collections: [col],
        boundSource: { type: 'collection', id: col.id },
      }),
    ).rejects.toThrow(/operator pipeline failed/i);
  });
});
