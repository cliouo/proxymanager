import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, Rule, Subscription } from '@/schemas';

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
    const result = await resolveConfig(BASE_WITH_LITERAL, [], subs, [], {});

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
    const result = await resolveConfig(BASE_WITH_LITERAL, [], subs, [], {});

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

    const result = await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], {});

    expect(result.collisions).toEqual([
      { name: '直连', keptFrom: null, droppedFrom: ['a'] },
    ]);
    expect(result.inlinedProxyCount).toBe(1);
    expect(result.nodeNames).toEqual(['直连', 'HK-01']);
  });

  it('strips deprecated pm-inline-collections and emits a warning', async () => {
    const baseWithLegacy = `${BASE_WITH_LITERAL}\npm-inline-collections:\n  - old-pool\n`;
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'X' }]), proxyCount: 1 });

    const result = await resolveConfig(baseWithLegacy, [], [makeSub({ name: 'a' })], [], {});

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

    const result = await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], {});

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

    const result = await resolveConfig(BASE_WITH_LITERAL, [rule], [makeSub({ name: 'a' })], [], {});

    expect(result.content).toContain('DOMAIN-SUFFIX,example.com,默认');
    expect(result.anchorsApplied.find((a) => a.anchor === 'manual')?.ruleCount).toBe(1);
  });

  it('writes the resolved snapshot by default', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });
    await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], {});
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    const [snapshot] = snapshotMock.mock.calls[0];
    expect(snapshot.nodeNames).toContain('HK-01');
  });

  it('skips snapshot persistence when persistSnapshot is false', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });
    await resolveConfig(BASE_WITH_LITERAL, [], [makeSub({ name: 'a' })], [], {
      persistSnapshot: false,
    });
    expect(snapshotMock).not.toHaveBeenCalled();
  });
});

function makeCollection(over: Partial<Collection>): Collection {
  return {
    id: crypto.randomUUID(),
    name: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    ...over,
  } as Collection;
}

describe('resolveConfig — collection pool-groups', () => {
  it('emits an enabled collection as a proxy-group over its member nodes', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }, { name: 'HK-02' }]), proxyCount: 2 })
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'JP-01' }]), proxyCount: 1 });

    const subA = makeSub({ name: 'air-a' });
    const subB = makeSub({ name: 'air-b' });
    const pool = makeCollection({
      name: 'main-pool',
      subscription_ids: [subA.id, subB.id],
    });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [subA, subB], [pool], {});

    expect(result.pools).toEqual([
      { name: 'main-pool', type: 'select', memberCount: 3 },
    ]);
    expect(result.content).toMatch(/name: main-pool\s+type: select\s+proxies:[^]*HK-01[^]*HK-02[^]*JP-01/);
  });

  it('skips a disabled collection with reason', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });
    const sub = makeSub({ name: 'air-a' });
    const pool = makeCollection({
      name: 'paused-pool',
      enabled: false,
      subscription_ids: [sub.id],
    });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [sub], [pool], {});
    expect(result.pools[0]).toEqual({
      name: 'paused-pool',
      type: 'select',
      memberCount: 0,
      skipped: true,
      reason: 'collection 已停用',
    });
    expect(result.content).not.toContain('paused-pool');
  });

  it('skips a collection whose name collides with an existing proxy-group', async () => {
    resolveSubMock.mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 });
    const sub = makeSub({ name: 'air-a' });
    // 默认 is already a proxy-group in BASE_WITH_LITERAL
    const pool = makeCollection({ name: '默认', subscription_ids: [sub.id] });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [sub], [pool], {});
    expect(result.pools[0].skipped).toBe(true);
    expect(result.pools[0].reason).toContain('已存在');
  });

  it('skips a collection with no available member nodes', async () => {
    const sub = makeSub({ name: 'off', enabled: false });
    const pool = makeCollection({ name: 'empty-pool', subscription_ids: [sub.id] });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [sub], [pool], {});
    expect(result.pools[0].skipped).toBe(true);
    expect(result.pools[0].reason).toContain('无可用节点');
  });

  it('resolves members by both subscription_ids and tags', async () => {
    resolveSubMock
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'HK-01' }]), proxyCount: 1 })
      .mockResolvedValueOnce({ yaml: providerYaml([{ name: 'JP-01' }]), proxyCount: 1 });
    const subA = makeSub({ name: 'air-a', tags: [] });
    const subB = makeSub({ name: 'air-b', tags: ['asia'] });
    const pool = makeCollection({
      name: 'mix-pool',
      subscription_ids: [subA.id],
      subscription_tags: ['asia'],
    });
    const result = await resolveConfig(BASE_WITH_LITERAL, [], [subA, subB], [pool], {});
    expect(result.pools[0].memberCount).toBe(2);
    expect(result.content).toMatch(/mix-pool[^]*HK-01[^]*JP-01/);
  });
});
