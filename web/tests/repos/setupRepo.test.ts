import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigPreflightUnavailableError } from '@/lib/config/errors';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { buildStarterBlueprint } from '@/lib/setup/starterBlueprint';

const kv = new Map<string, unknown>();
const hashes = new Map<string, Map<string, unknown>>();
const zsets = new Map<string, Map<string, number>>();
const forcedTypes = new Map<string, string>();
let failEval = false;

function hash(key: string): Map<string, unknown> {
  let value = hashes.get(key);
  if (!value) {
    value = new Map();
    hashes.set(key, value);
  }
  return value;
}

function zset(key: string): Map<string, number> {
  let value = zsets.get(key);
  if (!value) {
    value = new Map();
    zsets.set(key, value);
  }
  return value;
}

function redisType(key: string): string {
  const forced = forcedTypes.get(key);
  if (forced) return forced;
  if (kv.has(key)) return 'string';
  if ((hashes.get(key)?.size ?? 0) > 0) return 'hash';
  if ((zsets.get(key)?.size ?? 0) > 0) return 'zset';
  return 'none';
}

const fakeRedis = {
  type: async (key: string) => redisType(key),
  get: async (key: string) => kv.get(key) ?? null,
  hgetall: async (key: string) => {
    const value = hash(key);
    return value.size > 0 ? Object.fromEntries(value) : null;
  },
  eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
    if (failEval) throw new Error('injected eval failure');
    const [
      versionKey,
      profilesKey,
      baseContentKey,
      baseMetaKey,
      groupsKey,
      rulesKey,
      snapshotKey,
      provenanceKey,
      auditEventsKey,
      auditByIdKey,
    ] = keys;
    const expectedVersion = Number(args[0]);
    const currentVersion = Number(kv.get(versionKey) ?? 0);
    if (currentVersion !== expectedVersion) return [0, String(currentVersion)];

    const profileId = args[1];
    const writeProfile = args[2] === '1';
    const writeBase = args[4] === '1';
    const writeGroups = args[7] === '1';
    const groupCount = Number(args[8]);
    const rulesFlagIndex = 9 + groupCount * 2;
    const writeRules = args[rulesFlagIndex] === '1';
    const ruleCount = Number(args[rulesFlagIndex + 1]);
    const profileExists = hash(profilesKey).has(profileId);
    const baseCount = Number(kv.has(baseContentKey)) + Number(kv.has(baseMetaKey));
    const groupsExist = hash(groupsKey).size > 0;
    const rulesExist = hash(rulesKey).size > 0;
    if (profileExists === writeProfile) return [-1, 'profile-presence'];
    if ((writeBase && baseCount !== 0) || (!writeBase && baseCount !== 2)) {
      return [-1, 'base-presence'];
    }
    if (groupsExist === writeGroups) return [-1, 'group-presence'];
    if (rulesExist === writeRules) return [-1, 'rule-presence'];
    if (kv.has(provenanceKey)) return [-1, 'provenance-exists'];

    if (writeProfile) hash(profilesKey).set(profileId, JSON.parse(args[3]));
    if (writeBase) {
      kv.set(baseContentKey, args[5]);
      kv.set(baseMetaKey, JSON.parse(args[6]));
    }
    if (writeGroups) {
      let index = 9;
      for (let i = 0; i < groupCount; i += 1) {
        hash(groupsKey).set(args[index++], JSON.parse(args[index++]));
      }
    }
    let tailIndex = rulesFlagIndex + 2;
    if (writeRules) {
      for (let i = 0; i < ruleCount; i += 1) {
        hash(rulesKey).set(args[tailIndex++], JSON.parse(args[tailIndex++]));
      }
    }
    const receipt = JSON.parse(args[tailIndex++]);
    const eventId = args[tailIndex++];
    const eventTs = Number(args[tailIndex++]);
    const event = JSON.parse(args[tailIndex]);
    kv.set(provenanceKey, receipt);
    zset(auditEventsKey).set(eventId, eventTs);
    hash(auditByIdKey).set(eventId, event);
    if (zset(auditEventsKey).size > 1000) {
      const overflow = zset(auditEventsKey).size - 1000;
      const evicted = [...zset(auditEventsKey).entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, overflow);
      for (const [id] of evicted) {
        zset(auditEventsKey).delete(id);
        hash(auditByIdKey).delete(id);
      }
    }
    hash(snapshotKey).delete(profileId);
    kv.set(versionKey, currentVersion + 1);
    return [1, String(currentVersion + 1), eventId];
  }),
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

import { commitSetupBootstrap, inspectSetupRoot, inspectSetupStorage } from '@/lib/repos/setupRepo';

function plan() {
  const starter = buildStarterBlueprint(1_700_000_000);
  return {
    expectedVersion: 0,
    profile: starter.profile,
    writeProfile: true,
    baseContent: starter.baseContent,
    baseMeta: starter.baseMeta,
    writeBase: true,
    proxyGroups: starter.proxyGroups,
    writeProxyGroups: true,
    rules: starter.rules,
    writeRules: true,
    buildId: 'abcdef12',
    created: true,
  };
}

describe('setupRepo raw inspection', () => {
  beforeEach(() => {
    kv.clear();
    hashes.clear();
    zsets.clear();
    forcedTypes.clear();
    failEval = false;
    fakeRedis.eval.mockClear();
  });

  it('returns raw profile count inputs and a valid missing revision', async () => {
    hash(REDIS_KEYS.profiles).set('broken', { legacy: true });

    const root = await inspectSetupRoot();

    expect(root).toMatchObject({
      revision: 0,
      revisionValid: true,
      profilesRaw: { broken: { legacy: true } },
      profilesTypeValid: true,
      provenanceRaw: null,
      provenanceTypeValid: true,
      commitStorageTypesValid: true,
    });
  });

  it('reports WRONGTYPE components without issuing the wrong read command', async () => {
    const profileId = plan().profile.id;
    forcedTypes.set(REDIS_KEYS.proxyGroups(profileId), 'string');

    const storage = await inspectSetupStorage(profileId);

    expect(storage.typeIssues).toEqual(['proxy-groups']);
    expect(storage.proxyGroupsRaw).toEqual({});
  });
});

describe('setupRepo atomic bootstrap', () => {
  beforeEach(() => {
    kv.clear();
    hashes.clear();
    zsets.clear();
    forcedTypes.clear();
    failEval = false;
    fakeRedis.eval.mockClear();
  });

  it('commits resources, provenance, audit, invalidation, and one version bump together', async () => {
    const input = plan();
    hash(REDIS_KEYS.resolvedSnapshot).set(input.profile.id, { buildId: 'old' });
    const result = await commitSetupBootstrap(input);

    expect(result).toMatchObject({
      ok: true,
      currentVersion: 1,
      provenance: {
        starter_version: 'starter-v1',
        expected_revision: 0,
        completed_revision: 1,
        created: true,
        profile_id: input.profile.id,
        base_etag: input.baseMeta.etag,
        build_id: 'abcdef12',
        proxy_group_ids: input.proxyGroups.map((group) => group.id),
        rule_ids: input.rules.map((rule) => rule.id),
      },
    });
    expect(hash(REDIS_KEYS.profiles).has(input.profile.id)).toBe(true);
    expect(kv.get(REDIS_KEYS.base.content(input.profile.id))).toBe(input.baseContent);
    expect(hash(REDIS_KEYS.proxyGroups(input.profile.id))).toHaveLength(2);
    expect(hash(REDIS_KEYS.rules(input.profile.id))).toHaveLength(1);
    expect(hash(REDIS_KEYS.resolvedSnapshot).has(input.profile.id)).toBe(false);
    expect(kv.get(REDIS_KEYS.configVersion)).toBe(1);
    expect(kv.get(REDIS_KEYS.setupProvenance)).toMatchObject({
      audit_event_id: expect.any(String),
    });

    const eventId = result.provenance?.audit_event_id ?? '';
    expect(zset(REDIS_KEYS.audit.events).has(eventId)).toBe(true);
    expect(hash(REDIS_KEYS.audit.byId).get(eventId)).toMatchObject({
      op: 'setup.bootstrap',
      actor: 'admin',
      target: { kind: 'profile' },
      undoable: false,
      profileId: input.profile.id,
      after: {
        starter_version: 'starter-v1',
        listener_ports: 'client-managed',
        base_etag: input.baseMeta.etag,
        build_id: 'abcdef12',
      },
    });
    expect(JSON.stringify(hash(REDIS_KEYS.audit.byId).get(eventId))).not.toMatch(
      /token|url|secret|password/iu,
    );
  });

  it('allows only one concurrent empty-state commit', async () => {
    const input = plan();
    const [first, second] = await Promise.all([
      commitSetupBootstrap(input),
      commitSetupBootstrap(input),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toEqual({
      ok: false,
      conflict: 'config-version',
      currentVersion: 1,
    });
    expect(hash(REDIS_KEYS.profiles)).toHaveLength(1);
    expect(zset(REDIS_KEYS.audit.events)).toHaveLength(1);
    expect(hash(REDIS_KEYS.audit.byId)).toHaveLength(1);
  });

  it('rejects a presence conflict before applying resources, provenance, or audit', async () => {
    const input = plan();
    kv.set(REDIS_KEYS.base.content(input.profile.id), 'occupied');

    const result = await commitSetupBootstrap(input);

    expect(result).toMatchObject({ ok: false, conflict: 'presence' });
    expect(hash(REDIS_KEYS.profiles)).toHaveLength(0);
    expect(hash(REDIS_KEYS.proxyGroups(input.profile.id))).toHaveLength(0);
    expect(hash(REDIS_KEYS.rules(input.profile.id))).toHaveLength(0);
    expect(kv.get(REDIS_KEYS.setupProvenance)).toBeUndefined();
    expect(zset(REDIS_KEYS.audit.events)).toHaveLength(0);
    expect(hash(REDIS_KEYS.audit.byId)).toHaveLength(0);
    expect(kv.get(REDIS_KEYS.configVersion)).toBeUndefined();
  });

  it('leaves no half-initialized data when the single atomic eval fails', async () => {
    const input = plan();
    failEval = true;

    await expect(commitSetupBootstrap(input)).rejects.toBeInstanceOf(
      ConfigPreflightUnavailableError,
    );

    expect(hash(REDIS_KEYS.profiles)).toHaveLength(0);
    expect(hash(REDIS_KEYS.proxyGroups(input.profile.id))).toHaveLength(0);
    expect(hash(REDIS_KEYS.rules(input.profile.id))).toHaveLength(0);
    expect(zset(REDIS_KEYS.audit.events)).toHaveLength(0);
    expect(hash(REDIS_KEYS.audit.byId)).toHaveLength(0);
    expect(kv).toEqual(new Map());
  });

  it('reuses the 1000-event audit trimming convention in the same atomic write', async () => {
    for (let index = 0; index < 1000; index += 1) {
      const id = `old-${index}`;
      zset(REDIS_KEYS.audit.events).set(id, index);
      hash(REDIS_KEYS.audit.byId).set(id, { id });
    }

    const result = await commitSetupBootstrap(plan());

    expect(result.ok).toBe(true);
    expect(zset(REDIS_KEYS.audit.events)).toHaveLength(1000);
    expect(hash(REDIS_KEYS.audit.byId)).toHaveLength(1000);
    expect(zset(REDIS_KEYS.audit.events).has('old-0')).toBe(false);
    expect(hash(REDIS_KEYS.audit.byId).has('old-0')).toBe(false);
  });
});
