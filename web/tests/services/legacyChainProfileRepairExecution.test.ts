import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseRecord } from '@/lib/repos/baseRepo';
import type { Collection, Profile, ProxyGroup, Subscription } from '@/schemas';

const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PROFILE_ID = 'abababab-abab-4bab-8bab-abababababab';
const COLLECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOURCE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXIT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const US_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const POOL_ID = '11111111-1111-4111-8111-111111111111';
const CHAIN_ID = '22222222-2222-4222-8222-222222222222';
const CONSUMER_ID = '33333333-3333-4333-8333-333333333333';
const ETAG = 'feedfacefeedface';
const SECRET_SPX = 'secret-spider-path';

const base: BaseRecord = {
  content: `
proxies:
  - name: 直连
    type: direct
    udp: true
# === PROXY-GROUPS ===
rules:
  # === ANCHOR: prelude ===
  # === ANCHOR: manual ===
  # === ANCHOR: late ===
`,
  etag: ETAG,
  anchors: ['manual'],
  policies: ['直连', 'DIRECT'],
  updated_at: 1,
};

function group(input: Partial<ProxyGroup> & Pick<ProxyGroup, 'id' | 'name'>): ProxyGroup {
  return {
    type: 'select',
    kind: 'manual',
    rank: 10,
    updated_at: 1,
    ...input,
  } as ProxyGroup;
}

const groups: ProxyGroup[] = [
  group({ id: EXIT_ID, name: '出口', proxies: ['直连'] }),
  group({
    id: US_ID,
    name: '美国',
    kind: 'filter',
    'include-all-proxies': true,
    filter: String.raw`(?i)(🇺🇸|\bUS\b|美)`,
  }),
  group({
    id: DE_ID,
    name: '德国',
    kind: 'filter',
    'include-all-proxies': true,
    filter: String.raw`(?i)(🇩🇪|\bDE\b|德)`,
  }),
  group({
    id: POOL_ID,
    name: 'pool-to-missing-backend',
    type: 'fallback',
    kind: 'filter',
    'include-all-proxies': true,
    filter: 'US',
  }),
  group({
    id: CHAIN_ID,
    name: 'chain:pool-to-missing-backend',
    kind: 'raw',
    proxies: ['missing-backend'],
    'dialer-proxy': 'pool-to-missing-backend',
  }),
  group({
    id: CONSUMER_ID,
    name: 'OpenAI',
    proxies: ['出口', 'chain:pool-to-missing-backend'],
  }),
];

const source: Subscription = {
  id: SOURCE_ID,
  name: 'mynode',
  enabled: true,
  kind: 'local',
  content:
    'vless://00000000-0000-0000-0000-000000000000@good.example:443?type=tcp#good\n' +
    `vless://00000000-0000-0000-0000-000000000000@spx.example:443?type=tcp&spx=${SECRET_SPX}#spx\n`,
  ttl_ms: 600_000,
  tags: [],
  operators: [],
  updated_at: 1,
};

const collection: Collection = {
  id: COLLECTION_ID,
  name: '我的聚合订阅',
  slug: 'mine',
  enabled: true,
  type: 'select',
  subscription_ids: [SOURCE_ID],
  subscription_tags: [],
  operators: [],
};

const profile: Profile = {
  id: PROFILE_ID,
  name: 'default',
  source: { type: 'collection', id: COLLECTION_ID },
  kind: 'normal',
  updated_at: 1,
};

const repairs = [
  { id: US_ID, filter: '(?i)(🇺🇸|(?<![A-Za-z])USA?(?![A-Za-z])|美)' },
  { id: DE_ID, filter: '(?i)(🇩🇪|(?<![A-Za-z])DEU?(?![A-Za-z])|德)' },
];
// The parser now drops Reality spiderX, so spx sources parse cleanly and the
// quarantine path can never build a plan; the commit-path tests exercise the
// stale-chain removal alone. `inputWithQuarantine` remains only to prove the
// shared-source guard still fires before any quarantine is attempted.
const input = {
  alias: '直连',
  repairs,
  staleChain: {
    chainGroupId: CHAIN_ID,
    frontPoolGroupId: POOL_ID,
    consumerGroupId: CONSUMER_ID,
  },
};
const inputWithQuarantine = { ...input, quarantineSpxSubscriptionId: SOURCE_ID };

let versions: number[] = [7, 7, 7];
let profiles: Profile[] = [profile];
let resolvedNodeNames: string[] = [];
let evalResult: [number, number | string, string?] = [1, 8, 'audit-id'];
const resolveMock = vi.fn(async (...args: unknown[]) => {
  void args;
  return { nodeNames: resolvedNodeNames };
});
const evalMock = vi.fn(async (...args: unknown[]) => {
  void args;
  return evalResult;
});

vi.mock('@/lib/repos/configVersionRepo', () => ({
  getConfigVersion: vi.fn(async () => versions.shift() ?? 7),
}));
vi.mock('@/lib/repos/baseRepo', () => ({ getBase: vi.fn(async () => base) }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({ listProxyGroups: vi.fn(async () => groups) }));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: vi.fn(async () => []) }));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({
  listProxyGroupTemplates: vi.fn(async () => []),
}));
vi.mock('@/lib/repos/profilesRepo', () => ({
  getProfile: vi.fn(async () => profile),
  listProfiles: vi.fn(async () => profiles),
}));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: vi.fn(async () => []) }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  listSubscriptions: vi.fn(async () => [source]),
}));
vi.mock('@/lib/repos/collectionsRepo', () => ({
  listCollections: vi.fn(async () => [collection]),
}));
vi.mock('@/lib/engine/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/resolve')>();
  return { ...actual, resolveConfig: resolveMock };
});
vi.mock('@/lib/services/configPreflight', () => ({
  resolveSubscriptionForPreflight: vi.fn(),
}));
vi.mock('@/lib/redis/client', () => ({ getRedis: () => ({ eval: evalMock }) }));

let service: typeof import('@/lib/services/legacyChainProfileRepairService');

beforeEach(async () => {
  versions = [7, 7, 7];
  profiles = [profile];
  resolvedNodeNames = [];
  evalResult = [1, 8, 'audit-id'];
  resolveMock.mockClear();
  evalMock.mockClear();
  service = await import('@/lib/services/legacyChainProfileRepairService');
});

describe('legacy chain profile recovery execution', () => {
  it('preflights and commits stale-chain removal plus profile repair in one Redis script', async () => {
    const result = await service.executeLegacyChainProfileRepair(
      PROFILE_ID,
      input,
      7,
      ETAG,
      'test-actor',
    );

    expect(resolveMock).toHaveBeenCalledOnce();
    const [, , candidateSubscriptions, candidateGroups, , options] = resolveMock.mock.calls[0];
    expect(options).toMatchObject({ ignoreFailedSubs: false, persistSnapshot: false });
    // No quarantine: the source (spx line included) is passed through untouched.
    expect(candidateSubscriptions).toEqual([expect.objectContaining({ id: SOURCE_ID })]);
    expect(candidateGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: EXIT_ID, proxies: ['DIRECT'] }),
        expect.objectContaining({ id: CONSUMER_ID, proxies: ['出口'] }),
      ]),
    );
    expect(candidateGroups).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: CHAIN_ID }),
        expect.objectContaining({ id: POOL_ID }),
      ]),
    );

    expect(evalMock).toHaveBeenCalledOnce();
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("actual = actual.ok");
    expect(script.indexOf("redis.call('TYPE', key)")).toBeLessThan(
      script.indexOf("redis.call('SET', KEYS[2]"),
    );
    expect(script).toContain("redis.call('HDEL', KEYS[4]");
    expect(script).toContain("redis.call('HSET', KEYS[6]");
    expect(script).toContain("redis.call('DEL', KEYS[7])");
    expect(keys).toEqual([
      'config:version',
      `base:content:${PROFILE_ID}`,
      `base:meta:${PROFILE_ID}`,
      `proxy-groups:${PROFILE_ID}`,
      `rules:${PROFILE_ID}`,
      'subscriptions',
      'resolved:snapshot',
      'audit:events',
      'audit:by_id',
    ]);
    expect(args).toContain(CHAIN_ID);
    expect(args).toContain(POOL_ID);
    // No subscription rewrite means no raw URI content in the script args.
    expect(args.some((arg) => arg.includes(SECRET_SPX))).toBe(false);
    const audit = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    expect(audit).toMatchObject({
      op: 'legacy-chain-profile-repair.apply',
      target: { kind: 'profile' },
      undoable: false,
    });
    expect(JSON.stringify(audit)).not.toContain(SECRET_SPX);
    expect(JSON.stringify(audit)).not.toContain('vless://');
    expect(result).toMatchObject({
      newVersion: 8,
      auditEventId: 'audit-id',
      summary: {
        repairedFilterGroups: ['美国', '德国'],
        staleChain: { backendName: 'missing-backend' },
      },
    });
    expect(result.summary.spxQuarantine).toBeUndefined();
  });

  it('refuses to delete a chain whose concrete backend exists after source repair', async () => {
    resolvedNodeNames = ['missing-backend'];

    await expect(
      service.executeLegacyChainProfileRepair(PROFILE_ID, input, 7, ETAG, 'test-actor'),
    ).rejects.toMatchObject({ problem: { status: 422 } });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('refuses to rewrite a shared source without preflighting every affected profile', async () => {
    profiles = [
      profile,
      {
        id: OTHER_PROFILE_ID,
        name: 'other',
        source: { type: 'collection', id: COLLECTION_ID },
        kind: 'normal',
        updated_at: 1,
      },
    ];

    await expect(
      service.executeLegacyChainProfileRepair(PROFILE_ID, inputWithQuarantine, 7, ETAG, 'test-actor'),
    ).rejects.toMatchObject({ problem: { status: 422 } });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('reports an invalid Redis storage shape without retrying', async () => {
    evalResult = [-2, 'storage-type'];

    await expect(
      service.executeLegacyChainProfileRepair(PROFILE_ID, input, 7, ETAG, 'test-actor'),
    ).rejects.toMatchObject({ problem: { status: 409 } });
    expect(evalMock).toHaveBeenCalledOnce();
  });

  it('reports a concurrency conflict without retrying or partially writing', async () => {
    evalResult = [0, 8];

    await expect(
      service.executeLegacyChainProfileRepair(PROFILE_ID, input, 7, ETAG, 'test-actor'),
    ).rejects.toMatchObject({ problem: { status: 409 } });
    expect(evalMock).toHaveBeenCalledOnce();
  });

  it('reports a base ETag conflict without a second write attempt', async () => {
    evalResult = [-1, 7];

    await expect(
      service.executeLegacyChainProfileRepair(PROFILE_ID, input, 7, ETAG, 'test-actor'),
    ).rejects.toMatchObject({ problem: { status: 409 } });
    expect(evalMock).toHaveBeenCalledOnce();
  });
});
