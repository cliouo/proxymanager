import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigPreflightUnavailableError, ConfigValidationError } from '@/lib/config/errors';
import type { BaseRecord } from '@/lib/repos/baseRepo';
import type { Profile, ProxyGroup, Rule, RuleSet, Subscription } from '@/schemas';

const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RULE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ETAG = 'feedfacefeedface';
const US_GROUP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DE_GROUP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SUBSCRIPTION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const EMPTY_SUBSCRIPTION_FAILURE_SIGNATURE = createHash('sha256').update('[]').digest('hex');

const preflightResolverMock = vi.hoisted(() => vi.fn());

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

const group: ProxyGroup = {
  id: GROUP_ID,
  kind: 'manual',
  name: '出口',
  type: 'select',
  rank: 10,
  proxies: ['直连'],
  updated_at: 1,
};

const usGroup: ProxyGroup = {
  id: US_GROUP_ID,
  kind: 'filter',
  name: '美国',
  type: 'select',
  rank: 20,
  filter: String.raw`(?i)(🇺🇸|\bUS\b|美)`,
  'include-all-proxies': true,
  updated_at: 1,
};

const deGroup: ProxyGroup = {
  id: DE_GROUP_ID,
  kind: 'filter',
  name: '德国',
  type: 'select',
  rank: 30,
  filter: String.raw`(?i)(🇩🇪|\bDE\b|德)`,
  'include-all-proxies': true,
  updated_at: 1,
};

const disabledRule: Rule = {
  id: RULE_ID,
  anchor: 'manual',
  type: 'MATCH',
  value: '',
  policy: '直连',
  rank: 10,
  source: 'manual',
  added_at: 1,
  updated_at: 1,
  enabled: false,
};

const profile: Profile = {
  id: PROFILE_ID,
  name: 'default',
  source: { type: 'none' },
  updated_at: 1,
};

const invalidSubscription = {
  id: SUBSCRIPTION_ID,
  name: 'invalid-source',
  enabled: true,
  kind: 'local',
  content: '',
  ttl_ms: 3_600_000,
  tags: [],
  operators: [],
} as Subscription;

let versions: number[] = [7, 7, 7];
let groups: ProxyGroup[] = [group];
let requireCombinedRepair = false;
let sourceFailure: Error | null = null;
const evalMock = vi.fn(async (_script: string, _keys: string[], args: string[]) => [
  1,
  8,
  args.at(-3),
]);
const resolveMock = vi.fn(async (baseContent: string, ...args: unknown[]) => {
  const options = args[4] as {
    ignoreFailedSubs?: boolean;
    subscriptionResolver?: (subscription: Subscription) => Promise<unknown>;
  };
  if (sourceFailure && options.subscriptionResolver) {
    try {
      await options.subscriptionResolver(invalidSubscription);
    } catch (error) {
      if (options.ignoreFailedSubs === false) throw error;
    }
  }
  if (requireCombinedRepair) {
    const candidateGroups = args[2] as ProxyGroup[];
    const filters = new Map(candidateGroups.map((item) => [item.name, item.filter]));
    const aliasRemoved = !baseContent.includes('name: 直连');
    const filtersRepaired =
      filters.get('美国') === '(?i)(🇺🇸|(?<![A-Za-z])USA?(?![A-Za-z])|美)' &&
      filters.get('德国') === '(?i)(🇩🇪|(?<![A-Za-z])DEU?(?![A-Za-z])|德)';
    if (!aliasRemoved || !filtersRepaired) throw new Error('candidate is only partially repaired');
  }
  return { content: 'ok' };
});
let providers: RuleSet[] = [];

vi.mock('@/lib/repos/configVersionRepo', () => ({
  getConfigVersion: vi.fn(async () => versions.shift() ?? 7),
}));
vi.mock('@/lib/repos/baseRepo', () => ({ getBase: vi.fn(async () => base) }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({
  listProxyGroups: vi.fn(async () => groups),
}));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: vi.fn(async () => [disabledRule]) }));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({
  listProxyGroupTemplates: vi.fn(async () => []),
}));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: vi.fn(async () => profile) }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({
  listRuleSets: vi.fn(async () => providers),
}));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({ listSubscriptions: vi.fn(async () => []) }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: vi.fn(async () => []) }));
vi.mock('@/lib/engine/resolve', () => ({ resolveConfig: resolveMock }));
vi.mock('@/lib/services/configPreflight', () => ({
  resolveSubscriptionForPreflight: preflightResolverMock,
}));
vi.mock('@/lib/redis/client', () => ({ getRedis: () => ({ eval: evalMock }) }));

let service: typeof import('@/lib/services/directMigrationService');
let repairService: typeof import('@/lib/services/legacyProfileRepairService');

beforeEach(async () => {
  versions = [7, 7, 7];
  groups = [group];
  requireCombinedRepair = false;
  sourceFailure = null;
  providers = [];
  evalMock.mockClear();
  resolveMock.mockClear();
  preflightResolverMock.mockReset();
  preflightResolverMock.mockImplementation(async () => {
    if (sourceFailure) throw sourceFailure;
    return { proxies: [], stale: false };
  });
  service = await import('@/lib/services/directMigrationService');
  repairService = await import('@/lib/services/legacyProfileRepairService');
});

describe('executeDirectAliasMigration', () => {
  it('isolates a deterministic pre-existing subscription error during structural migration', async () => {
    sourceFailure = new ConfigValidationError({
      code: 'subscription_content_invalid',
      message: 'A subscription contains invalid proxy nodes.',
      section: 'subscriptions',
      path: 'subscriptions[invalid-source].content',
      resource: 'subscription',
    });

    const plan = await service.planDirectAliasMigration(PROFILE_ID, '直连');

    expect(plan.summary.isolatedSubscriptionFailures).toBe(1);
    expect(plan.subscriptionFailureSignature).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolveMock.mock.calls[0]?.[5]).toMatchObject({ ignoreFailedSubs: true });
  });

  it('keeps temporary subscription preflight failures blocking the migration', async () => {
    sourceFailure = new ConfigPreflightUnavailableError();

    await expect(service.planDirectAliasMigration(PROFILE_ID, '直连')).rejects.toBe(sourceFailure);
  });

  it('rejects execution when the subscription failure set changed after confirmation', async () => {
    sourceFailure = new ConfigValidationError({
      code: 'subscription_content_invalid',
      message: 'A subscription contains invalid proxy nodes.',
      section: 'subscriptions',
      path: 'subscriptions[invalid-source].content',
      resource: 'subscription',
    });

    await expect(
      service.executeDirectAliasMigration(
        PROFILE_ID,
        '直连',
        7,
        ETAG,
        'test-actor',
        EMPTY_SUBSCRIPTION_FAILURE_SIGNATURE,
      ),
    ).rejects.toMatchObject({ problem: { status: 409 } });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('commits base, groups, rules and audit in one guarded Redis script', async () => {
    const result = await service.executeDirectAliasMigration(
      PROFILE_ID,
      '直连',
      7,
      ETAG,
      'test-actor',
      EMPTY_SUBSCRIPTION_FAILURE_SIGNATURE,
    );

    expect(resolveMock).toHaveBeenCalledOnce();
    expect(resolveMock.mock.calls[0]?.[5]).toMatchObject({
      persistSnapshot: false,
      subscriptionResolver: expect.any(Function),
    });
    expect(evalMock).toHaveBeenCalledOnce();
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("redis.call('SET', KEYS[2]");
    expect(script).toContain("redis.call('HSET', KEYS[4]");
    expect(script).toContain("redis.call('HSET', KEYS[5]");
    expect(script).toContain("redis.call('HDEL', KEYS[6], ARGV[5])");
    expect(script).toContain("redis.call('ZADD', KEYS[7]");
    expect(keys).toEqual([
      'config:version',
      `base:content:${PROFILE_ID}`,
      `base:meta:${PROFILE_ID}`,
      `proxy-groups:${PROFILE_ID}`,
      `rules:${PROFILE_ID}`,
      'resolved:snapshot',
      'audit:events',
      'audit:by_id',
    ]);
    expect(args).toContain(PROFILE_ID);
    expect(
      args.some((arg) => arg.includes('"policy":"DIRECT"') && arg.includes('"enabled":false')),
    ).toBe(true);
    expect(args.some((arg) => arg.includes('"proxies":["DIRECT"]'))).toBe(true);
    expect(JSON.parse(args.at(-1) ?? '{}')).toMatchObject({
      op: 'direct-migration.replace-alias',
      target: { kind: 'base', field: 'proxies' },
      before: { isolatedSubscriptionFailures: 0 },
      after: { subscriptionFailuresChanged: false },
      undoable: false,
    });
    expect(result).toMatchObject({ newVersion: 8, summary: { disabledRulesTouched: 1 } });
    expect(result.auditEventId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('aborts before commit when configVersion changes after validation', async () => {
    versions = [7, 7, 8];
    await expect(
      service.executeDirectAliasMigration(
        PROFILE_ID,
        '直连',
        7,
        ETAG,
        'test-actor',
        EMPTY_SUBSCRIPTION_FAILURE_SIGNATURE,
      ),
    ).rejects.toMatchObject({ problem: { status: 409 } });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('binds execution to the base ETag shown by the confirmation preview', async () => {
    await expect(
      service.executeDirectAliasMigration(
        PROFILE_ID,
        '直连',
        7,
        'deadbeefdeadbeef',
        'test-actor',
        EMPTY_SUBSCRIPTION_FAILURE_SIGNATURE,
      ),
    ).rejects.toMatchObject({ problem: { status: 409 } });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('refuses a shared managed rule-set whose proxy still names the alias', async () => {
    providers = [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        name: 'shared-provider',
        source: 'remote',
        format: 'yaml',
        behavior: 'classical',
        content: '',
        url: 'https://example.com/rules.yaml',
        proxy: '直连',
        updated_at: 1,
      } as RuleSet,
    ];
    await expect(
      service.executeDirectAliasMigration(
        PROFILE_ID,
        '直连',
        7,
        ETAG,
        'test-actor',
        EMPTY_SUBSCRIPTION_FAILURE_SIGNATURE,
      ),
    ).rejects.toMatchObject({ problem: { status: 422 } });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('repairs a direct alias and multiple invalid filters in one validated commit', async () => {
    groups = [group, usGroup, deGroup];
    requireCombinedRepair = true;
    const repairs = [
      {
        id: US_GROUP_ID,
        filter: '(?i)(🇺🇸|(?<![A-Za-z])USA?(?![A-Za-z])|美)',
      },
      {
        id: DE_GROUP_ID,
        filter: '(?i)(🇩🇪|(?<![A-Za-z])DEU?(?![A-Za-z])|德)',
      },
    ];

    await expect(service.planDirectAliasMigration(PROFILE_ID, '直连')).rejects.toThrow(
      'candidate is only partially repaired',
    );
    versions = [7, 7, 7];

    const result = await repairService.executeLegacyProfileRepair(
      PROFILE_ID,
      '直连',
      repairs,
      7,
      ETAG,
      'test-actor',
      EMPTY_SUBSCRIPTION_FAILURE_SIGNATURE,
    );

    expect(resolveMock).toHaveBeenCalledTimes(2);
    expect(evalMock).toHaveBeenCalledOnce();
    const [, , args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(args.some((arg) => arg.includes('"proxies":["DIRECT"]'))).toBe(true);
    expect(args.some((arg) => arg.includes('(?<![A-Za-z])USA?'))).toBe(true);
    expect(args.some((arg) => arg.includes('(?<![A-Za-z])DEU?'))).toBe(true);
    expect(JSON.parse(args.at(-1) ?? '{}')).toMatchObject({
      op: 'legacy-profile-repair.apply',
      target: { kind: 'profile' },
      undoable: false,
    });
    expect(result.summary.repairedFilterGroups).toEqual(['美国', '德国']);
    expect(result).toMatchObject({ newVersion: 8 });
  });
});
