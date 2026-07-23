import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { BaseMeta } from '@/lib/repos/baseRepo';
import type { Device } from '@/schemas';

export interface TailscaleDeviceMigrationCommit {
  expectedVersion: number;
  baseContent: string;
  baseMeta: BaseMeta;
  device: Device;
  ruleDeletes: readonly string[];
  proxyGroupDeletes: readonly string[];
  backupKey: string;
  backupValue: unknown;
}

/**
 * One all-or-nothing migration commit:
 * shared base node + managed group/rules disappear in the same generation in
 * which the device feature appears. A reader can observe either the legacy
 * shape or the device shape, never a half-migrated mixture.
 */
const CAS_MIGRATE_TAILSCALE_DEVICE = `
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
  or not hasExpectedType(KEYS[7], 'hash') then
  return {-2, 'storage-type'}
end

local backupType = redis.call('TYPE', KEYS[8])
if type(backupType) == 'table' then backupType = backupType.ok end
if backupType ~= 'none' then
  return {-2, 'backup-exists'}
end

local currentRaw = redis.call('GET', KEYS[1])
local current = tonumber(currentRaw or '0')
local expected = tonumber(ARGV[1])
if not current or current % 1 ~= 0 then
  return {-2, 'config-version'}
end
if current ~= expected then
  return {0, currentRaw or ''}
end

redis.call('SET', KEYS[8], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[4], ARGV[5], ARGV[6])

local index = 7
local ruleDeleteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, ruleDeleteCount do
  redis.call('HDEL', KEYS[5], ARGV[index])
  index = index + 1
end

local groupDeleteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, groupDeleteCount do
  redis.call('HDEL', KEYS[6], ARGV[index])
  index = index + 1
end

redis.call('HDEL', KEYS[7], ARGV[index])
local nextVersion = redis.call('INCR', KEYS[1])
return {1, tostring(nextVersion)}
`.trim();

export async function commitTailscaleDeviceMigration(
  profileId: string,
  input: TailscaleDeviceMigrationCommit,
): Promise<{
  ok: boolean;
  currentVersion: number | null;
  conflict?: 'version' | 'storage';
}> {
  const ruleDeletes = [...new Set(input.ruleDeletes)];
  const groupDeletes = [...new Set(input.proxyGroupDeletes)];
  const args = [
    String(input.expectedVersion),
    JSON.stringify(input.backupValue),
    input.baseContent,
    JSON.stringify(input.baseMeta),
    input.device.id,
    JSON.stringify(input.device),
    String(ruleDeletes.length),
    ...ruleDeletes,
    String(groupDeletes.length),
    ...groupDeletes,
    profileId,
  ];

  const result = (await getRedis().eval(
    CAS_MIGRATE_TAILSCALE_DEVICE,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.base.content(profileId),
      REDIS_KEYS.base.meta(profileId),
      REDIS_KEYS.devices(profileId),
      REDIS_KEYS.rules(profileId),
      REDIS_KEYS.proxyGroups(profileId),
      REDIS_KEYS.resolvedSnapshot,
      input.backupKey,
    ],
    args,
  )) as [number, string];

  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  const code = Array.isArray(result) ? result[0] : -2;
  return {
    ok: code === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
    ...(code === 0 ? { conflict: 'version' as const } : {}),
    ...(code === -2 ? { conflict: 'storage' as const } : {}),
  };
}
