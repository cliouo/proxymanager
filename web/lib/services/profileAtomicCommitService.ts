import { ClientSafeProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { BaseMeta } from '@/lib/repos/baseRepo';
import type { AuditEvent, AuditTarget, ProxyGroup, Rule } from '@/schemas';

export interface AtomicProfileConfigPlan {
  baseContent: string;
  baseMeta: BaseMeta;
  groups: ProxyGroup[];
  rules: Rule[];
  expectedVersion: number;
  expectedBaseEtag: string;
}

export interface AtomicProfileAudit {
  op: AuditEvent['op'];
  target: AuditTarget;
  before?: unknown;
  after?: unknown;
  /** These bespoke migrations have no registered safe inverse. */
  undoable: false;
}

const COMMIT_ATOMIC_PROFILE_CONFIG = `
local currentVersion = redis.call('GET', KEYS[1]) or '0'
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
local groupCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, groupCount do
  redis.call('HSET', KEYS[4], ARGV[index], ARGV[index + 1])
  index = index + 2
end

local ruleCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, ruleCount do
  redis.call('HSET', KEYS[5], ARGV[index], ARGV[index + 1])
  index = index + 2
end

redis.call('HDEL', KEYS[6], ARGV[5])
local eventId = ARGV[index]
local eventTs = tonumber(ARGV[index + 1])
local eventJson = ARGV[index + 2]
redis.call('ZADD', KEYS[7], eventTs, eventId)
redis.call('HSET', KEYS[8], eventId, eventJson)
local auditCount = redis.call('ZCARD', KEYS[7])
if auditCount > 1000 then
  local overflow = auditCount - 1000
  local evicted = redis.call('ZRANGE', KEYS[7], 0, overflow - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[7], 0, overflow - 1)
  for _, oldId in ipairs(evicted) do redis.call('HDEL', KEYS[8], oldId) end
end
local nextVersion = redis.call('INCR', KEYS[1])
return {1, nextVersion, eventId}
`.trim();

function versionConflict(expected: number, current: number): ClientSafeProblemDetailsError {
  return ClientSafeProblemDetailsError.conflict(
    `配置在迁移预览后发生了变化（预期版本 ${expected}，当前版本 ${current}），请重新预览。`,
  );
}

/**
 * Persist one already-preflighted base/groups/rules candidate, its audit event,
 * snapshot invalidation, and generation increment in one guarded Redis script.
 */
export async function commitAtomicProfileConfig(
  profileId: string,
  actor: string,
  plan: AtomicProfileConfigPlan,
  audit: AtomicProfileAudit,
): Promise<{ newVersion: number; auditEventId: string }> {
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    op: audit.op,
    actor,
    target: audit.target,
    before: audit.before,
    after: audit.after,
    undoable: audit.undoable,
    profileId,
  };
  const args: string[] = [
    String(plan.expectedVersion),
    plan.expectedBaseEtag,
    plan.baseContent,
    JSON.stringify(plan.baseMeta),
    profileId,
    String(plan.groups.length),
  ];
  for (const group of plan.groups) args.push(group.id, JSON.stringify(group));
  args.push(String(plan.rules.length));
  for (const rule of plan.rules) args.push(rule.id, JSON.stringify(rule));
  args.push(event.id, String(event.ts), JSON.stringify(event));

  const result = (await getRedis().eval(
    COMMIT_ATOMIC_PROFILE_CONFIG,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.base.content(profileId),
      REDIS_KEYS.base.meta(profileId),
      REDIS_KEYS.proxyGroups(profileId),
      REDIS_KEYS.rules(profileId),
      REDIS_KEYS.resolvedSnapshot,
      REDIS_KEYS.audit.events,
      REDIS_KEYS.audit.byId,
    ],
    args,
  )) as [number, number | string, string?];
  if (!Array.isArray(result) || result[0] !== 1) {
    if (Array.isArray(result) && result[0] === -1) {
      throw ClientSafeProblemDetailsError.conflict(
        'base.yaml 在迁移期间被其他写入修改，请重新预览。',
      );
    }
    const current = Number(Array.isArray(result) ? result[1] : NaN);
    throw versionConflict(plan.expectedVersion, Number.isSafeInteger(current) ? current : -1);
  }
  return { newVersion: Number(result[1]), auditEventId: result[2] ?? event.id };
}
