import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { attachRawOperators, restoreRawOperators } from '@/lib/repos/rawOperators';
import { SubscriptionSchema, type Subscription } from '@/schemas';

/**
 * Run stored rows through the Zod schema so defaults (kind, ttl_ms, tags)
 * are filled in for records persisted before the field existed. This is
 * the migration path — no separate one-shot script needed.
 */
function normalise(raw: unknown): Subscription | null {
  const parsed = SubscriptionSchema.safeParse(raw);
  if (!parsed.success) {
    // P3-10: a silently-dropped subscription looks like data loss to the user.
    const name = (raw as { name?: unknown })?.name;
    console.warn(
      `[subscriptionsRepo] skipping unparseable subscription${
        typeof name === 'string' ? ` "${name}"` : ''
      }: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
    return null;
  }
  // Raw persisted operators travel with the parsed record on a symbol: spreads
  // carry it, JSON never serializes it. Non-operator writes then restore the
  // raw bytes instead of persisting the parked decode (rawOperators.ts).
  const rawOperators = (raw as { operators?: unknown })?.operators;
  return rawOperators === undefined ? parsed.data : attachRawOperators(parsed.data, rawOperators);
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.subscriptions);
  if (!all) return [];
  const out: Subscription[] = [];
  for (const raw of Object.values(all)) {
    const sub = normalise(raw);
    if (sub) out.push(sub);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.subscriptions, id);
  return normalise(raw);
}

export async function getSubscriptionByName(name: string): Promise<Subscription | null> {
  const all = await listSubscriptions();
  return all.find((s) => s.name === name) ?? null;
}

// Writes bump config:version in the same multi() — subscription records
// (enabled/url/prefix/operators…) shape the rendered config. Note this also
// fires for pure runtime-state updates (last_synced_at / last_traffic);
// over-invalidation is safe, just an extra render.

export async function upsertSubscription(sub: Subscription): Promise<void> {
  // Non-operator writes must not destroy raw future-operator bytes.
  const toStore = restoreRawOperators(sub);
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.subscriptions, { [sub.id]: toStore })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

/**
 * Atomically compare config:version, apply one subscription write and bump
 * the generation exactly once — the commit half of the node-processing save
 * gate. A subscription's operators shape every consuming profile's rendered
 * config, so the write must land under the same generation the preflight
 * validated; losing the race is a 412 + retry, not a silently different
 * persisted state.
 */
export const CAS_SUBSCRIPTION_CHANGE = `
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
-- pass-4 finding: the same pre-write discipline as the naming CAS — every
-- TYPE and VALUE precondition is proven BEFORE the first mutation, and the
-- version is SET to the exact canonical next string (never INCR, whose
-- runtime error on a non-canonical stored value would land AFTER the HSET).
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

export interface SubscriptionCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

export async function commitSubscriptionChange(
  sub: Subscription,
  expectedVersion: number,
): Promise<SubscriptionCommitResult> {
  // Explicit operator saves replace the array (restoreRawOperators is a
  // no-op then); saves of OTHER render-affecting fields keep raw bytes.
  const toStore = restoreRawOperators(sub);
  const result = (await getRedis().eval(
    CAS_SUBSCRIPTION_CHANGE,
    [REDIS_KEYS.configVersion, REDIS_KEYS.subscriptions],
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
 * exactly once. Deleting a shared source changes every consuming profile's
 * rendered output — the same preflight-then-commit discipline as writes.
 */
export const CAS_SUBSCRIPTION_DELETE = `
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
-- CAS_SUBSCRIPTION_CHANGE) — HDEL only after every precondition is proven.
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

export async function commitSubscriptionDelete(
  id: string,
  expectedVersion: number,
): Promise<SubscriptionCommitResult> {
  const result = (await getRedis().eval(
    CAS_SUBSCRIPTION_DELETE,
    [REDIS_KEYS.configVersion, REDIS_KEYS.subscriptions],
    [String(expectedVersion), id],
  )) as [number, string];
  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.subscriptions, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
