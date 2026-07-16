import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { ProxyGroup, Rule } from '@/schemas';

export interface ProfileConfigChanges {
  ruleWrites?: readonly Rule[];
  ruleDeletes?: readonly string[];
  proxyGroupWrites?: readonly ProxyGroup[];
  proxyGroupDeletes?: readonly string[];
}

export interface ProfileConfigCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

/**
 * Atomically compare config:version, apply rule/proxy-group changes, and bump
 * the generation exactly once. This is the commit half of save preflight: a
 * concurrent mutation after validation cannot turn the checked candidate into
 * a different persisted state.
 */
const CAS_PROFILE_CONFIG_CHANGES = `
local currentRaw = redis.call('GET', KEYS[1])
local current = tonumber(currentRaw or '0')
local expected = tonumber(ARGV[1])
if not current or current ~= expected then
  return {0, currentRaw or ''}
end

local index = 3
local ruleWriteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, ruleWriteCount do
  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
  index = index + 2
end
local ruleDeleteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, ruleDeleteCount do
  redis.call('HDEL', KEYS[2], ARGV[index])
  index = index + 1
end

local groupWriteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, groupWriteCount do
  redis.call('HSET', KEYS[3], ARGV[index], ARGV[index + 1])
  index = index + 2
end
local groupDeleteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, groupDeleteCount do
  redis.call('HDEL', KEYS[3], ARGV[index])
  index = index + 1
end

redis.call('HDEL', KEYS[4], ARGV[2])
local nextVersion = redis.call('INCR', KEYS[1])
return {1, tostring(nextVersion)}
`.trim();

export async function commitProfileConfigChanges(
  profileId: string,
  changes: ProfileConfigChanges,
  expectedVersion: number,
): Promise<ProfileConfigCommitResult> {
  const ruleWrites = [
    ...new Map((changes.ruleWrites ?? []).map((rule) => [rule.id, rule])).values(),
  ];
  const groupWrites = [
    ...new Map((changes.proxyGroupWrites ?? []).map((group) => [group.id, group])).values(),
  ];
  const ruleDeletes = [...new Set(changes.ruleDeletes ?? [])];
  const groupDeletes = [...new Set(changes.proxyGroupDeletes ?? [])];

  if (
    ruleWrites.length === 0 &&
    ruleDeletes.length === 0 &&
    groupWrites.length === 0 &&
    groupDeletes.length === 0
  ) {
    return { ok: true, currentVersion: expectedVersion };
  }

  const args = [String(expectedVersion), profileId, String(ruleWrites.length)];
  for (const rule of ruleWrites) args.push(rule.id, JSON.stringify(rule));
  args.push(String(ruleDeletes.length), ...ruleDeletes, String(groupWrites.length));
  for (const group of groupWrites) args.push(group.id, JSON.stringify(group));
  args.push(String(groupDeletes.length), ...groupDeletes);

  const result = (await getRedis().eval(
    CAS_PROFILE_CONFIG_CHANGES,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.rules(profileId),
      REDIS_KEYS.proxyGroups(profileId),
      REDIS_KEYS.resolvedSnapshot,
    ],
    args,
  )) as [number, string];

  const rawVersion = Array.isArray(result) ? result[1] : '';
  const parsedVersion = Number(rawVersion);
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}
