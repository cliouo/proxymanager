import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { attachRawOperators, restoreRawOperators } from '@/lib/repos/rawOperators';
import { CollectionSchema, type Collection } from '@/schemas';

function normalise(raw: unknown): Collection | null {
  const parsed = CollectionSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Same raw-operator preservation contract as subscriptionsRepo.
  const rawOperators = (raw as { operators?: unknown })?.operators;
  return rawOperators === undefined ? parsed.data : attachRawOperators(parsed.data, rawOperators);
}

export async function listCollections(): Promise<Collection[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.collections);
  if (!all) return [];
  const out: Collection[] = [];
  for (const raw of Object.values(all)) {
    const c = normalise(raw);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCollection(id: string): Promise<Collection | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.collections, id);
  return normalise(raw);
}

export async function getCollectionByName(name: string): Promise<Collection | null> {
  const all = await listCollections();
  return all.find((c) => c.name === name) ?? null;
}

export async function getCollectionBySlug(slug: string): Promise<Collection | null> {
  const all = await listCollections();
  return all.find((c) => c.slug === slug) ?? null;
}

// Writes bump config:version in the same multi() — collections drive
// collection-scope proxy-groups and profile bindings in the rendered config.

export async function upsertCollection(col: Collection): Promise<void> {
  // Cosmetic patches (notes etc.) must not destroy raw future-operator bytes.
  const toStore = restoreRawOperators(col);
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.collections, { [col.id]: toStore })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

/**
 * Atomically compare config:version, apply one collection write and bump the
 * generation exactly once — the commit half of the node-processing save gate
 * (same rationale as commitSubscriptionChange).
 */
export const CAS_COLLECTION_CHANGE = `
local function isHashKey(key)
  local t = redis.call('TYPE', key).ok
  return t == 'hash' or t == 'none'
end
local function isStringKey(key)
  local t = redis.call('TYPE', key).ok
  return t == 'string' or t == 'none'
end
local function isCanonicalUnsigned(raw)
  if type(raw) ~= 'string' then return false end
  if not string.match(raw, '^[0-9]+$') then return false end
  if string.len(raw) > 1 and string.sub(raw, 1, 1) == '0' then return false end
  return true
end
-- pass-4 finding: same pre-write discipline as the naming CAS (see
-- CAS_SUBSCRIPTION_CHANGE) — HSET only after every precondition is proven,
-- and SET the exact canonical next version (never INCR after mutation).
if not isStringKey(KEYS[1]) then return {2, 'version-wrongtype'} end
if not isHashKey(KEYS[2]) then return {2, 'entity-wrongtype'} end
local currentRaw = redis.call('GET', KEYS[1])
local current = 0
-- pass-5 blocker: ONLY Redis nil/false means "missing". A STORED empty
-- string is truthy in Lua and must go through canonical validation —
-- isCanonicalUnsigned('') is false, so it fails version-malformed with
-- ZERO writes instead of being treated as version 0.
if currentRaw then
  if not isCanonicalUnsigned(currentRaw) then return {2, 'version-malformed'} end
  current = tonumber(currentRaw)
  if not current or current > 9007199254740990 then return {2, 'version-overflow'} end
end
local expected = tonumber(ARGV[1])
if not expected or current ~= expected then
  return {0, string.format('%.0f', current)}
end
local nextVersion = current + 1
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('SET', KEYS[1], string.format('%.0f', nextVersion))
return {1, string.format('%.0f', nextVersion)}
`.trim();

export interface CollectionCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

export async function commitCollectionChange(
  col: Collection,
  expectedVersion: number,
): Promise<CollectionCommitResult> {
  const toStore = restoreRawOperators(col);
  const result = (await getRedis().eval(
    CAS_COLLECTION_CHANGE,
    [REDIS_KEYS.configVersion, REDIS_KEYS.collections],
    [String(expectedVersion), toStore.id, JSON.stringify(toStore)],
  )) as [number, string];
  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}

/**
 * CAS delete for the save gate: compare config:version, HDEL the record, bump
 * exactly once (same preflight-then-commit discipline as writes).
 */
export const CAS_COLLECTION_DELETE = `
local function isHashKey(key)
  local t = redis.call('TYPE', key).ok
  return t == 'hash' or t == 'none'
end
local function isStringKey(key)
  local t = redis.call('TYPE', key).ok
  return t == 'string' or t == 'none'
end
local function isCanonicalUnsigned(raw)
  if type(raw) ~= 'string' then return false end
  if not string.match(raw, '^[0-9]+$') then return false end
  if string.len(raw) > 1 and string.sub(raw, 1, 1) == '0' then return false end
  return true
end
-- pass-4 finding: same pre-write discipline as the naming CAS (see
-- CAS_SUBSCRIPTION_CHANGE) — HDEL only after every precondition is proven,
-- and SET the exact canonical next version (never INCR after mutation).
if not isStringKey(KEYS[1]) then return {2, 'version-wrongtype'} end
if not isHashKey(KEYS[2]) then return {2, 'entity-wrongtype'} end
local currentRaw = redis.call('GET', KEYS[1])
local current = 0
-- pass-5 blocker: ONLY Redis nil/false means "missing". A STORED empty
-- string is truthy in Lua and must go through canonical validation —
-- isCanonicalUnsigned('') is false, so it fails version-malformed with
-- ZERO writes instead of being treated as version 0.
if currentRaw then
  if not isCanonicalUnsigned(currentRaw) then return {2, 'version-malformed'} end
  current = tonumber(currentRaw)
  if not current or current > 9007199254740990 then return {2, 'version-overflow'} end
end
local expected = tonumber(ARGV[1])
if not expected or current ~= expected then
  return {0, string.format('%.0f', current)}
end
local nextVersion = current + 1
redis.call('HDEL', KEYS[2], ARGV[2])
redis.call('SET', KEYS[1], string.format('%.0f', nextVersion))
return {1, string.format('%.0f', nextVersion)}
`.trim();

export async function commitCollectionDelete(
  id: string,
  expectedVersion: number,
): Promise<CollectionCommitResult> {
  const result = (await getRedis().eval(
    CAS_COLLECTION_DELETE,
    [REDIS_KEYS.configVersion, REDIS_KEYS.collections],
    [String(expectedVersion), id],
  )) as [number, string];
  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}

export async function deleteCollection(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.collections, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
