import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { DeviceSchema, type Device } from '@/schemas';

function normalise(raw: unknown): Device | null {
  const parsed = DeviceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** One profile's devices, sorted by `name` for determinism (mirrors listProfiles). */
export async function listDevices(profileId: string): Promise<Device[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.devices(profileId));
  if (!all) return [];
  const out: Device[] = [];
  for (const raw of Object.values(all)) {
    const device = normalise(raw);
    if (device) out.push(device);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDevice(profileId: string, deviceId: string): Promise<Device | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.devices(profileId), deviceId);
  return normalise(raw);
}

/** Look up by the kebab-case name that appears in the subscription URL. */
export async function getDeviceByName(profileId: string, name: string): Promise<Device | null> {
  const all = await listDevices(profileId);
  return all.find((d) => d.name === name) ?? null;
}

export interface DeviceCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

/**
 * Atomically compare `config:version`, apply the device write/delete, and bump
 * the generation exactly once — the commit half of save preflight, in the same
 * shape as {@link commitProfileConfigChanges}.
 *
 * Why CAS rather than a plain multi: preflight validated this device's patch
 * against a specific rendered candidate. If the shared layer moved underneath
 * us between validation and commit, the patch we're about to persist was never
 * checked against what's actually stored. Losing the race is a 412 + retry, not
 * a silently unvalidated write.
 *
 * The version bump is also what invalidates both render caches (shared and
 * device), so there is no explicit invalidation anywhere in the device layer.
 */
const CAS_DEVICE_WRITE = `
local currentRaw = redis.call('GET', KEYS[1])
local current = tonumber(currentRaw or '0')
local expected = tonumber(ARGV[1])
if not current or current ~= expected then
  return {0, currentRaw or ''}
end

local writeCount = tonumber(ARGV[2])
local index = 3
for _ = 1, writeCount do
  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
  index = index + 2
end
local deleteCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, deleteCount do
  redis.call('HDEL', KEYS[2], ARGV[index])
  index = index + 1
end

local nextVersion = redis.call('INCR', KEYS[1])
return {1, tostring(nextVersion)}
`.trim();

export interface DeviceChanges {
  writes?: readonly Device[];
  deletes?: readonly string[];
}

export async function commitDeviceChanges(
  profileId: string,
  changes: DeviceChanges,
  expectedVersion: number,
): Promise<DeviceCommitResult> {
  const writes = [...new Map((changes.writes ?? []).map((d) => [d.id, d])).values()];
  const deletes = [...new Set(changes.deletes ?? [])];
  if (writes.length === 0 && deletes.length === 0) {
    return { ok: true, currentVersion: expectedVersion };
  }

  const args = [String(expectedVersion), String(writes.length)];
  for (const device of writes) args.push(device.id, JSON.stringify(device));
  args.push(String(deletes.length), ...deletes);

  const result = (await getRedis().eval(
    CAS_DEVICE_WRITE,
    [REDIS_KEYS.configVersion, REDIS_KEYS.devices(profileId)],
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

/**
 * Copy every device of `srcProfileId` into `destProfileId` with fresh ids and
 * timestamps, names preserved (`copy_from` on profile create, §2.4).
 *
 * P2's device-level feature instances are deliberately NOT copied — they carry
 * uniqueness-bearing fields (a tailnet hostname, an auth key) that would collide
 * the moment both profiles came up. Those must be re-enabled on the new profile.
 */
export async function cloneDevices(
  srcProfileId: string,
  destProfileId: string,
  now: number,
): Promise<number> {
  const devices = await listDevices(srcProfileId);
  if (devices.length === 0) return 0;
  const cloned: Record<string, Device> = {};
  for (const device of devices) {
    const id = crypto.randomUUID();
    cloned[id] = {
      ...device,
      id,
      features: {},
      created_at: now,
      updated_at: now,
    };
  }
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.devices(destProfileId), cloned)
    .incr(REDIS_KEYS.configVersion)
    .exec();
  return devices.length;
}
