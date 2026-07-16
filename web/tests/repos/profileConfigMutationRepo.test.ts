import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { ProxyGroup, Rule } from '@/schemas';

const hashes = new Map<string, Map<string, unknown>>();
let version = 0;

function hash(key: string): Map<string, unknown> {
  let value = hashes.get(key);
  if (!value) {
    value = new Map();
    hashes.set(key, value);
  }
  return value;
}

const fakeRedis = {
  eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
    const [, rulesKey, groupsKey, snapshotKey] = keys;
    const [expected, profileId] = args;
    if (version !== Number(expected)) return [0, String(version)];
    let index = 2;
    const ruleWriteCount = Number(args[index++]);
    for (let i = 0; i < ruleWriteCount; i += 1) {
      const id = args[index++];
      hash(rulesKey).set(id, args[index++]);
    }
    const ruleDeleteCount = Number(args[index++]);
    for (let i = 0; i < ruleDeleteCount; i += 1) hash(rulesKey).delete(args[index++]);
    const groupWriteCount = Number(args[index++]);
    for (let i = 0; i < groupWriteCount; i += 1) {
      const id = args[index++];
      hash(groupsKey).set(id, args[index++]);
    }
    const groupDeleteCount = Number(args[index++]);
    for (let i = 0; i < groupDeleteCount; i += 1) hash(groupsKey).delete(args[index++]);
    hash(snapshotKey).delete(profileId);
    version += 1;
    return [1, String(version)];
  }),
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

import { commitProfileConfigChanges } from '@/lib/repos/profileConfigMutationRepo';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const RULE = {
  id: 'rule-new',
  anchor: 'manual',
  type: 'MATCH',
  value: '',
  policy: 'DIRECT',
  rank: 10,
  source: 'manual',
  added_at: 1,
  updated_at: 1,
} as Rule;
const GROUP = {
  id: 'group-new',
  kind: 'raw',
  name: 'Proxy',
  type: 'select',
  proxies: ['DIRECT'],
  rank: 10,
  created_at: 1,
  updated_at: 1,
} as ProxyGroup;

describe('commitProfileConfigChanges', () => {
  beforeEach(() => {
    hashes.clear();
    version = 5;
    fakeRedis.eval.mockClear();
    hash(REDIS_KEYS.rules(PROFILE_ID)).set('rule-old', { id: 'rule-old' });
    hash(REDIS_KEYS.proxyGroups(PROFILE_ID)).set('group-old', { id: 'group-old' });
    hash(REDIS_KEYS.resolvedSnapshot).set(PROFILE_ID, { buildId: 'stale' });
  });

  it('does not mutate either hash when the preflight generation is stale', async () => {
    const beforeRules = [...hash(REDIS_KEYS.rules(PROFILE_ID)).entries()];
    const beforeGroups = [...hash(REDIS_KEYS.proxyGroups(PROFILE_ID)).entries()];

    const result = await commitProfileConfigChanges(
      PROFILE_ID,
      {
        ruleWrites: [RULE],
        ruleDeletes: ['rule-old'],
        proxyGroupWrites: [GROUP],
        proxyGroupDeletes: ['group-old'],
      },
      4,
    );

    expect(result).toEqual({ ok: false, currentVersion: 5 });
    expect([...hash(REDIS_KEYS.rules(PROFILE_ID)).entries()]).toEqual(beforeRules);
    expect([...hash(REDIS_KEYS.proxyGroups(PROFILE_ID)).entries()]).toEqual(beforeGroups);
    expect(hash(REDIS_KEYS.resolvedSnapshot).has(PROFILE_ID)).toBe(true);
    expect(version).toBe(5);
  });

  it('applies the checked rule/group set and bumps once on a matching generation', async () => {
    const result = await commitProfileConfigChanges(
      PROFILE_ID,
      {
        ruleWrites: [RULE],
        ruleDeletes: ['rule-old'],
        proxyGroupWrites: [GROUP],
        proxyGroupDeletes: ['group-old'],
      },
      5,
    );

    expect(result).toEqual({ ok: true, currentVersion: 6 });
    expect([...hash(REDIS_KEYS.rules(PROFILE_ID)).keys()]).toEqual(['rule-new']);
    expect(JSON.parse(hash(REDIS_KEYS.rules(PROFILE_ID)).get('rule-new') as string)).toEqual(RULE);
    expect([...hash(REDIS_KEYS.proxyGroups(PROFILE_ID)).keys()]).toEqual(['group-new']);
    expect(JSON.parse(hash(REDIS_KEYS.proxyGroups(PROFILE_ID)).get('group-new') as string)).toEqual(
      GROUP,
    );
    expect(hash(REDIS_KEYS.resolvedSnapshot).has(PROFILE_ID)).toBe(false);
    expect(version).toBe(6);
  });

  it('passes empty arrays as raw JSON so Lua cannot turn them into objects', async () => {
    const rule = { ...RULE, options: [] } as Rule;
    const group = { ...GROUP, proxies: [] } as ProxyGroup;

    await commitProfileConfigChanges(
      PROFILE_ID,
      { ruleWrites: [rule], proxyGroupWrites: [group] },
      5,
    );

    expect(hash(REDIS_KEYS.rules(PROFILE_ID)).get(rule.id)).toBe(JSON.stringify(rule));
    expect(hash(REDIS_KEYS.proxyGroups(PROFILE_ID)).get(group.id)).toBe(JSON.stringify(group));
  });
});
