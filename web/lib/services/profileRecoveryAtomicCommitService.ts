import { ClientSafeProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { BaseMeta } from '@/lib/repos/baseRepo';
import type { AuditEvent, AuditTarget, ProxyGroup, Rule, Subscription } from '@/schemas';

export interface AtomicProfileRecoveryPlan {
  baseContent: string;
  baseMeta: BaseMeta;
  groups: ProxyGroup[];
  groupDeletes: string[];
  rules: Rule[];
  subscriptions: Subscription[];
  expectedVersion: number;
  expectedBaseEtag: string;
}

export interface AtomicProfileRecoveryAudit {
  op: AuditEvent['op'];
  target: AuditTarget;
  before?: unknown;
  after?: unknown;
  undoable: false;
}

const COMMIT_ATOMIC_PROFILE_RECOVERY = `
local function hasExpectedType(key, expected)
  local actual = redis.call('TYPE', key)
  if type(actual) == 'table' then actual = actual.ok end
  return actual == 'none' or actual == expected
end

if not hasExpectedType(KEYS[1], 'string')
  or not hasExpectedType(KEYS[2], 'string')
  or not hasExpectedType(KEYS[3], 'string')
  or not hasExpectedType(KEYS[4], 'hash')
  or not hasExpectedType(KEYS[5], 'hash')
  or not hasExpectedType(KEYS[6], 'hash')
  or not hasExpectedType(KEYS[8], 'zset')
  or not hasExpectedType(KEYS[9], 'hash') then
  return {-2, 'storage-type'}
end

local currentVersion = redis.call('GET', KEYS[1]) or '0'
local currentVersionNumber = tonumber(currentVersion)
if not currentVersionNumber or currentVersionNumber % 1 ~= 0 then
  return {-2, 'config-version'}
end
if currentVersion ~= ARGV[1] then return {0, currentVersion} end

local currentMetaRaw = redis.call('GET', KEYS[3])
local currentEtag = ''
if currentMetaRaw then
  local ok, currentMeta = pcall(cjson.decode, currentMetaRaw)
  if ok and type(currentMeta) == 'table' and currentMeta.etag ~= nil then
    currentEtag = tostring(currentMeta.etag)
  end
end
if currentEtag ~= ARGV[2] then return {-1, currentVersion} end

redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])

local index = 6
local groupWriteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, groupWriteCount do
  redis.call('HSET', KEYS[4], ARGV[index], ARGV[index + 1])
  index = index + 2
end
local groupDeleteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, groupDeleteCount do
  redis.call('HDEL', KEYS[4], ARGV[index])
  index = index + 1
end

local ruleWriteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, ruleWriteCount do
  redis.call('HSET', KEYS[5], ARGV[index], ARGV[index + 1])
  index = index + 2
end

local subscriptionWriteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, subscriptionWriteCount do
  redis.call('HSET', KEYS[6], ARGV[index], ARGV[index + 1])
  index = index + 2
end

redis.call('DEL', KEYS[7])
local eventId = ARGV[index]
local eventTs = tonumber(ARGV[index + 1])
local eventJson = ARGV[index + 2]
redis.call('ZADD', KEYS[8], eventTs, eventId)
redis.call('HSET', KEYS[9], eventId, eventJson)
local auditCount = redis.call('ZCARD', KEYS[8])
if auditCount > 1000 then
  local overflow = auditCount - 1000
  local evicted = redis.call('ZRANGE', KEYS[8], 0, overflow - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[8], 0, overflow - 1)
  for _, oldId in ipairs(evicted) do redis.call('HDEL', KEYS[9], oldId) end
end
local nextVersion = currentVersionNumber + 1
redis.call('SET', KEYS[1], tostring(nextVersion))
return {1, nextVersion, eventId}
`.trim();

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export async function commitAtomicProfileRecovery(
  profileId: string,
  actor: string,
  plan: AtomicProfileRecoveryPlan,
  audit: AtomicProfileRecoveryAudit,
): Promise<{ newVersion: number; auditEventId: string }> {
  const deletedGroups = new Set(plan.groupDeletes);
  const groups = uniqueById(plan.groups).filter((group) => !deletedGroups.has(group.id));
  const groupDeletes = [...deletedGroups];
  const rules = uniqueById(plan.rules);
  const subscriptions = uniqueById(plan.subscriptions);
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    op: audit.op,
    actor,
    target: audit.target,
    before: audit.before,
    after: audit.after,
    undoable: false,
    profileId,
  };
  const args: string[] = [
    String(plan.expectedVersion),
    plan.expectedBaseEtag,
    plan.baseContent,
    JSON.stringify(plan.baseMeta),
    profileId,
    String(groups.length),
  ];
  for (const group of groups) args.push(group.id, JSON.stringify(group));
  args.push(String(groupDeletes.length), ...groupDeletes, String(rules.length));
  for (const rule of rules) args.push(rule.id, JSON.stringify(rule));
  args.push(String(subscriptions.length));
  for (const subscription of subscriptions) {
    args.push(subscription.id, JSON.stringify(subscription));
  }
  args.push(event.id, String(event.ts), JSON.stringify(event));

  const result = (await getRedis().eval(
    COMMIT_ATOMIC_PROFILE_RECOVERY,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.base.content(profileId),
      REDIS_KEYS.base.meta(profileId),
      REDIS_KEYS.proxyGroups(profileId),
      REDIS_KEYS.rules(profileId),
      REDIS_KEYS.subscriptions,
      REDIS_KEYS.resolvedSnapshot,
      REDIS_KEYS.audit.events,
      REDIS_KEYS.audit.byId,
    ],
    args,
  )) as [number, number | string, string?];

  if (!Array.isArray(result) || result[0] !== 1) {
    if (Array.isArray(result) && result[0] === -1) {
      throw ClientSafeProblemDetailsError.conflict(
        'base.yaml 在恢复期间被其他写入修改，请重新预览。',
      );
    }
    if (Array.isArray(result) && result[0] === -2) {
      throw ClientSafeProblemDetailsError.conflict(
        '恢复所需的存储结构状态异常，未执行任何写入。',
      );
    }
    const current = Number(Array.isArray(result) ? result[1] : NaN);
    throw ClientSafeProblemDetailsError.conflict(
      `配置在恢复预览后发生了变化（预期版本 ${plan.expectedVersion}，当前版本 ${Number.isSafeInteger(current) ? current : -1}），请重新预览。`,
    );
  }
  return { newVersion: Number(result[1]), auditEventId: result[2] ?? event.id };
}
