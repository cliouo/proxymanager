import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseRecord } from '@/lib/repos/baseRepo';
import type { Profile, ProxyGroup, Rule, RuleSet } from '@/schemas';

const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RULE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ETAG = 'feedfacefeedface';

const base: BaseRecord = {
  content: `
proxies:
  - name: 直连
    type: direct
    udp: true
# === PROXY-GROUPS ===
rules:
  # === ANCHOR: manual ===
  []
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

let versions: number[] = [7, 7, 7];
const evalMock = vi.fn(async (_script: string, _keys: string[], args: string[]) => [
  1,
  8,
  args.at(-3),
]);
const resolveMock = vi.fn(async (...args: unknown[]) => {
  void args;
  return { content: 'ok' };
});
let providers: RuleSet[] = [];

vi.mock('@/lib/repos/configVersionRepo', () => ({
  getConfigVersion: vi.fn(async () => versions.shift() ?? 7),
}));
vi.mock('@/lib/repos/baseRepo', () => ({ getBase: vi.fn(async () => base) }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({
  listProxyGroups: vi.fn(async () => [group]),
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
vi.mock('@/lib/redis/client', () => ({ getRedis: () => ({ eval: evalMock }) }));

let service: typeof import('@/lib/services/directMigrationService');

beforeEach(async () => {
  versions = [7, 7, 7];
  providers = [];
  evalMock.mockClear();
  resolveMock.mockClear();
  service = await import('@/lib/services/directMigrationService');
});

describe('executeDirectAliasMigration', () => {
  it('commits base, groups, rules and audit in one guarded Redis script', async () => {
    const result = await service.executeDirectAliasMigration(
      PROFILE_ID,
      '直连',
      7,
      ETAG,
      'test-actor',
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
    expect(result).toMatchObject({ newVersion: 8, summary: { disabledRulesTouched: 1 } });
    expect(result.auditEventId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('aborts before commit when configVersion changes after validation', async () => {
    versions = [7, 7, 8];
    await expect(
      service.executeDirectAliasMigration(PROFILE_ID, '直连', 7, ETAG, 'test-actor'),
    ).rejects.toMatchObject({ problem: { status: 409 } });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('binds execution to the base ETag shown by the confirmation preview', async () => {
    await expect(
      service.executeDirectAliasMigration(PROFILE_ID, '直连', 7, 'deadbeefdeadbeef', 'test-actor'),
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
      service.executeDirectAliasMigration(PROFILE_ID, '直连', 7, ETAG, 'test-actor'),
    ).rejects.toMatchObject({ problem: { status: 422 } });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(evalMock).not.toHaveBeenCalled();
  });
});
