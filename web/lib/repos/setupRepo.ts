import { getRedis } from '@/lib/redis/client';
import { ConfigPreflightUnavailableError } from '@/lib/config/errors';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { BaseMeta } from '@/lib/repos/baseRepo';
import {
  AuditEventSchema,
  SetupProvenanceSchema,
  type Profile,
  type ProxyGroup,
  type Rule,
  type SetupProvenance,
} from '@/schemas';

type RedisStorageType = 'none' | 'string' | 'hash' | 'zset' | 'list' | 'set' | 'stream';

export interface SetupRootInspection {
  revision: number;
  revisionValid: boolean;
  profilesRaw: Record<string, unknown>;
  profilesTypeValid: boolean;
  provenanceRaw: unknown | null;
  provenanceTypeValid: boolean;
  commitStorageTypesValid: boolean;
}

export interface SetupStorageInspection {
  baseContentPresent: boolean;
  baseMetaPresent: boolean;
  baseContent: string | null;
  baseMeta: unknown | null;
  proxyGroupsRaw: Record<string, unknown>;
  rulesRaw: Record<string, unknown>;
  typeIssues: Array<'base-content' | 'base-meta' | 'proxy-groups' | 'rules'>;
}

function hasType(actual: string, expected: RedisStorageType): boolean {
  return actual === 'none' || actual === expected;
}

/**
 * Read raw profile/provenance state without letting WRONGTYPE escape as a 500.
 * Callers can classify an unexpected type or malformed value as blocked while
 * transport failures still reject and are mapped to a credential-free 503.
 */
export async function inspectSetupRoot(): Promise<SetupRootInspection> {
  const redis = getRedis();
  const [revisionType, profilesType, provenanceType, snapshotType, auditEventsType, auditByIdType] =
    await Promise.all([
      redis.type(REDIS_KEYS.configVersion),
      redis.type(REDIS_KEYS.profiles),
      redis.type(REDIS_KEYS.setupProvenance),
      redis.type(REDIS_KEYS.resolvedSnapshot),
      redis.type(REDIS_KEYS.audit.events),
      redis.type(REDIS_KEYS.audit.byId),
    ]);
  const revisionTypeValid = hasType(revisionType, 'string');
  const profilesTypeValid = hasType(profilesType, 'hash');
  const provenanceTypeValid = hasType(provenanceType, 'string');
  const [revisionRaw, profilesRaw, provenanceRaw] = await Promise.all([
    revisionType === 'string' ? redis.get<unknown>(REDIS_KEYS.configVersion) : null,
    profilesType === 'hash' ? redis.hgetall<Record<string, unknown>>(REDIS_KEYS.profiles) : null,
    provenanceType === 'string' ? redis.get<unknown>(REDIS_KEYS.setupProvenance) : null,
  ]);
  const revision = Number(revisionRaw ?? 0);
  return {
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    revisionValid: revisionTypeValid && Number.isSafeInteger(revision) && revision >= 0,
    profilesRaw: profilesRaw ?? {},
    profilesTypeValid,
    provenanceRaw: provenanceRaw ?? null,
    provenanceTypeValid,
    commitStorageTypesValid:
      hasType(snapshotType, 'hash') &&
      hasType(auditEventsType, 'zset') &&
      hasType(auditByIdType, 'hash'),
  };
}

export async function inspectSetupStorage(profileId: string): Promise<SetupStorageInspection> {
  const redis = getRedis();
  const keys = {
    baseContent: REDIS_KEYS.base.content(profileId),
    baseMeta: REDIS_KEYS.base.meta(profileId),
    proxyGroups: REDIS_KEYS.proxyGroups(profileId),
    rules: REDIS_KEYS.rules(profileId),
  };
  const [baseContentType, baseMetaType, proxyGroupsType, rulesType] = await Promise.all([
    redis.type(keys.baseContent),
    redis.type(keys.baseMeta),
    redis.type(keys.proxyGroups),
    redis.type(keys.rules),
  ]);
  const typeIssues: SetupStorageInspection['typeIssues'] = [];
  if (!hasType(baseContentType, 'string')) typeIssues.push('base-content');
  if (!hasType(baseMetaType, 'string')) typeIssues.push('base-meta');
  if (!hasType(proxyGroupsType, 'hash')) typeIssues.push('proxy-groups');
  if (!hasType(rulesType, 'hash')) typeIssues.push('rules');

  const [baseContent, baseMeta, proxyGroupsRaw, rulesRaw] = await Promise.all([
    baseContentType === 'string' ? redis.get<unknown>(keys.baseContent) : null,
    baseMetaType === 'string' ? redis.get<unknown>(keys.baseMeta) : null,
    proxyGroupsType === 'hash' ? redis.hgetall<Record<string, unknown>>(keys.proxyGroups) : null,
    rulesType === 'hash' ? redis.hgetall<Record<string, unknown>>(keys.rules) : null,
  ]);
  return {
    baseContentPresent: baseContentType === 'string',
    baseMetaPresent: baseMetaType === 'string',
    baseContent: typeof baseContent === 'string' ? baseContent : null,
    baseMeta: baseMeta ?? null,
    proxyGroupsRaw: proxyGroupsRaw ?? {},
    rulesRaw: rulesRaw ?? {},
    typeIssues,
  };
}

export interface SetupBootstrapCommitPlan {
  expectedVersion: number;
  profile: Profile;
  writeProfile: boolean;
  baseContent: string;
  baseMeta: BaseMeta;
  writeBase: boolean;
  proxyGroups: readonly ProxyGroup[];
  writeProxyGroups: boolean;
  rules: readonly Rule[];
  writeRules: boolean;
  buildId: string;
  created: boolean;
}

export interface SetupBootstrapCommitResult {
  ok: boolean;
  conflict?: 'config-version' | 'presence' | 'storage-type';
  detail?: string;
  currentVersion: number | null;
  provenance?: SetupProvenance;
}

const COMMIT_SETUP_BOOTSTRAP = `
local function hasExpectedType(key, expected)
  local actual = redis.call('TYPE', key)
  if type(actual) == 'table' then actual = actual.ok end
  return actual == 'none' or actual == expected
end

if not hasExpectedType(KEYS[1], 'string')
  or not hasExpectedType(KEYS[2], 'hash')
  or not hasExpectedType(KEYS[3], 'string')
  or not hasExpectedType(KEYS[4], 'string')
  or not hasExpectedType(KEYS[5], 'hash')
  or not hasExpectedType(KEYS[6], 'hash')
  or not hasExpectedType(KEYS[7], 'hash')
  or not hasExpectedType(KEYS[8], 'string')
  or not hasExpectedType(KEYS[9], 'zset')
  or not hasExpectedType(KEYS[10], 'hash') then
  return {-2, 'storage-type'}
end

local currentRaw = redis.call('GET', KEYS[1]) or '0'
local current = tonumber(currentRaw)
local expected = tonumber(ARGV[1])
if not current or current % 1 ~= 0 or not expected or expected % 1 ~= 0 then
  return {-2, 'config-version'}
end
if current ~= expected then return {0, currentRaw} end

local profileId = ARGV[2]
local writeProfile = ARGV[3] == '1'
local writeBase = ARGV[5] == '1'
local writeGroups = ARGV[8] == '1'
local groupCount = tonumber(ARGV[9])
local index = 10 + (groupCount * 2)
local writeRules = ARGV[index] == '1'
local ruleCount = tonumber(ARGV[index + 1])

local profileExists = redis.call('HEXISTS', KEYS[2], profileId) == 1
if profileExists == writeProfile then
  return {-1, writeProfile and 'profile-exists' or 'profile-missing'}
end
local baseKeyCount = redis.call('EXISTS', KEYS[3], KEYS[4])
if (writeBase and baseKeyCount ~= 0) or (not writeBase and baseKeyCount ~= 2) then
  return {-1, writeBase and 'base-exists' or 'base-missing'}
end
local groupsExist = redis.call('EXISTS', KEYS[5]) == 1
if groupsExist == writeGroups then
  return {-1, writeGroups and 'proxy-groups-exist' or 'proxy-groups-missing'}
end
local rulesExist = redis.call('EXISTS', KEYS[6]) == 1
if rulesExist == writeRules then
  return {-1, writeRules and 'rules-exist' or 'rules-missing'}
end
if redis.call('EXISTS', KEYS[8]) ~= 0 then
  return {-1, 'provenance-exists'}
end

if writeProfile then redis.call('HSET', KEYS[2], profileId, ARGV[4]) end
if writeBase then
  redis.call('SET', KEYS[3], ARGV[6])
  redis.call('SET', KEYS[4], ARGV[7])
end
if writeGroups then
  local groupIndex = 10
  for _ = 1, groupCount do
    redis.call('HSET', KEYS[5], ARGV[groupIndex], ARGV[groupIndex + 1])
    groupIndex = groupIndex + 2
  end
end
local ruleIndex = index + 2
if writeRules then
  for _ = 1, ruleCount do
    redis.call('HSET', KEYS[6], ARGV[ruleIndex], ARGV[ruleIndex + 1])
    ruleIndex = ruleIndex + 2
  end
end

local provenanceJson = ARGV[ruleIndex]
local eventId = ARGV[ruleIndex + 1]
local eventTs = tonumber(ARGV[ruleIndex + 2])
local eventJson = ARGV[ruleIndex + 3]
redis.call('SET', KEYS[8], provenanceJson)
redis.call('ZADD', KEYS[9], eventTs, eventId)
redis.call('HSET', KEYS[10], eventId, eventJson)
local auditCount = redis.call('ZCARD', KEYS[9])
if auditCount > 1000 then
  local overflow = auditCount - 1000
  local evicted = redis.call('ZRANGE', KEYS[9], 0, overflow - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[9], 0, overflow - 1)
  for _, oldId in ipairs(evicted) do redis.call('HDEL', KEYS[10], oldId) end
end
redis.call('HDEL', KEYS[7], profileId)
local nextVersion = redis.call('INCR', KEYS[1])
return {1, tostring(nextVersion), eventId}
`.trim();

export async function commitSetupBootstrap(
  plan: SetupBootstrapCommitPlan,
): Promise<SetupBootstrapCommitResult> {
  const groups = [...new Map(plan.proxyGroups.map((group) => [group.id, group])).values()];
  const rules = [...new Map(plan.rules.map((rule) => [rule.id, rule])).values()];
  const eventId = crypto.randomUUID();
  const eventTs = Date.now();
  const provenance = SetupProvenanceSchema.parse({
    starter_version: 'starter-v1',
    expected_revision: plan.expectedVersion,
    completed_revision: plan.expectedVersion + 1,
    created: plan.created,
    profile_id: plan.profile.id,
    base_etag: plan.baseMeta.etag,
    build_id: plan.buildId,
    proxy_group_ids: groups.map((group) => group.id),
    rule_ids: rules.map((rule) => rule.id),
    audit_event_id: eventId,
  });
  const event = AuditEventSchema.parse({
    id: eventId,
    ts: eventTs,
    op: 'setup.bootstrap',
    actor: 'admin',
    target: { kind: 'profile' },
    after: {
      starter_version: provenance.starter_version,
      created: plan.created,
      listener_ports: 'client-managed',
      base_etag: provenance.base_etag,
      build_id: provenance.build_id,
      proxy_group_ids: provenance.proxy_group_ids,
      rule_ids: provenance.rule_ids,
    },
    undoable: false,
    profileId: plan.profile.id,
  });

  const args = [
    String(plan.expectedVersion),
    plan.profile.id,
    plan.writeProfile ? '1' : '0',
    JSON.stringify(plan.profile),
    plan.writeBase ? '1' : '0',
    plan.baseContent,
    JSON.stringify(plan.baseMeta),
    plan.writeProxyGroups ? '1' : '0',
    String(groups.length),
  ];
  for (const group of groups) args.push(group.id, JSON.stringify(group));
  args.push(plan.writeRules ? '1' : '0', String(rules.length));
  for (const rule of rules) args.push(rule.id, JSON.stringify(rule));
  args.push(JSON.stringify(provenance), event.id, String(event.ts), JSON.stringify(event));

  let result: [number, string, string?];
  try {
    result = (await getRedis().eval(
      COMMIT_SETUP_BOOTSTRAP,
      [
        REDIS_KEYS.configVersion,
        REDIS_KEYS.profiles,
        REDIS_KEYS.base.content(plan.profile.id),
        REDIS_KEYS.base.meta(plan.profile.id),
        REDIS_KEYS.proxyGroups(plan.profile.id),
        REDIS_KEYS.rules(plan.profile.id),
        REDIS_KEYS.resolvedSnapshot,
        REDIS_KEYS.setupProvenance,
        REDIS_KEYS.audit.events,
        REDIS_KEYS.audit.byId,
      ],
      args,
    )) as [number, string, string?];
  } catch {
    throw new ConfigPreflightUnavailableError();
  }

  const rawVersion = Array.isArray(result) ? result[1] : '';
  const parsedVersion = Number(rawVersion);
  if (Array.isArray(result) && result[0] === 1) {
    return {
      ok: true,
      currentVersion:
        Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
      provenance,
    };
  }
  if (Array.isArray(result) && result[0] === 0) {
    return {
      ok: false,
      conflict: 'config-version',
      currentVersion:
        Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
    };
  }
  return {
    ok: false,
    conflict: Array.isArray(result) && result[0] === -1 ? 'presence' : 'storage-type',
    detail: rawVersion || undefined,
    currentVersion: null,
  };
}
