import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { attachRawOperators, restoreRawOperators } from '@/lib/repos/rawOperators';
import { encodeOrdinalReservationPlan } from '@/lib/repos/ordinalReservationCas';
import { MAX_ORDINAL, MAX_TOTAL_ASSIGNMENTS } from '@/lib/repos/nodeOrdinalRepo';
import {
  MAX_REMOTE_SUBSCRIPTION_BODY_BYTES,
  type FetchCacheEntry,
} from '@/lib/repos/fetchCacheRepo';
import { safeJsonStringify } from '@/lib/security/safeJson';
import type { OrdinalReservationPlan } from '@/lib/services/nodeOrdinalService';
import { MAX_SUBSCRIPTION_CONTENT, SubscriptionSchema, type Subscription } from '@/schemas';

/**
 * Subscription-specific, fail-first CAS.
 *
 * KEYS: config version, definitions hash, naming history hash, ordinal hash,
 * ordinal generation, manual snapshot string, fetch-health string, resolved
 * snapshot hash, optional fetch-cache string, followed by one counter string
 * per planned source.
 *
 * ARGV: expected version, entity id/json/action, snapshot action/value,
 * health action, history field, fetch-cache action/value/TTL, then
 * encodeOrdinalReservationPlan().args.
 */
export const CAS_SUBSCRIPTION_MUTATION = `
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
local function isSafeUnsignedNumber(value)
  return type(value) == 'number' and value >= 0 and
         value == tonumber(string.format('%.0f', value)) and value <= 9007199254740990
end

if #KEYS < 9 then return {2, 'keys-malformed'} end
if not isStringKey(KEYS[1]) then return {2, 'version-wrongtype'} end
if not isHashKey(KEYS[2]) then return {2, 'entity-wrongtype'} end
if not isHashKey(KEYS[3]) then return {2, 'history-wrongtype'} end
if not isHashKey(KEYS[4]) then return {2, 'ordinal-hash-wrongtype'} end
if not isStringKey(KEYS[5]) then return {2, 'ordinal-generation-wrongtype'} end
if not isStringKey(KEYS[6]) then return {2, 'snapshot-wrongtype'} end
if not isStringKey(KEYS[7]) then return {2, 'health-wrongtype'} end
if not isHashKey(KEYS[8]) then return {2, 'resolved-snapshot-wrongtype'} end

local entityAction = ARGV[4]
local snapshotAction = ARGV[5]
local healthAction = ARGV[7]
local fetchCacheAction = ARGV[9]
if entityAction ~= 'set' and entityAction ~= 'delete' then
  return {2, 'entity-action-malformed'}
end
if snapshotAction ~= 'keep' and snapshotAction ~= 'set' and snapshotAction ~= 'delete' then
  return {2, 'snapshot-action-malformed'}
end
if healthAction ~= 'keep' and healthAction ~= 'delete' then
  return {2, 'health-action-malformed'}
end
if fetchCacheAction ~= 'keep' and fetchCacheAction ~= 'set' then
  return {2, 'fetch-cache-action-malformed'}
end
if not ARGV[2] or ARGV[2] == '' then return {2, 'entity-id-malformed'} end
local entity = nil
if entityAction == 'set' then
  if not ARGV[3] or ARGV[3] == '' then return {2, 'entity-json-malformed'} end
  local decodedEntity = cjson.decode(ARGV[3])
  if type(decodedEntity) ~= 'table' then return {2, 'entity-json-malformed'} end
  entity = decodedEntity
  if entity.manual_content ~= nil or entity.manual_updated_at ~= nil or
     entity.manual_update_origin ~= nil or entity.manual_proxy_count ~= nil or
     entity.manual_snapshot ~= nil then
    return {2, 'entity-contains-raw-snapshot'}
  end
  if entity.fetch_identity_revision ~= nil and
     not isSafeUnsignedNumber(entity.fetch_identity_revision) then
    return {2, 'fetch-identity-revision-malformed'}
  end
  if entity.kind == 'local' then
    if type(entity.content) ~= 'string' or entity.content == '' or
       entity.refresh_mode ~= nil or entity.manual_snapshot_meta ~= nil or
       snapshotAction ~= 'delete' then
      return {2, 'local-actions-malformed'}
    end
  elseif entity.kind == 'remote' then
    if type(entity.url) ~= 'string' or entity.url == '' or entity.content ~= nil or
       snapshotAction == 'delete' then
      return {2, 'remote-actions-malformed'}
    end
    local mode = entity.refresh_mode or 'server-auto'
    if mode ~= 'server-auto' and mode ~= 'manual' then
      return {2, 'refresh-mode-malformed'}
    end
    local meta = entity.manual_snapshot_meta
    if meta ~= nil then
      if type(meta) ~= 'table' or
         not isSafeUnsignedNumber(meta.updated_at) or
         not isSafeUnsignedNumber(meta.proxy_count) or meta.proxy_count < 1 or
         (meta.origin ~= 'web' and meta.origin ~= 'extension') or
         not isSafeUnsignedNumber(meta.fetch_identity_revision) or
         type(meta.content_sha256) ~= 'string' or
         string.len(meta.content_sha256) ~= 64 or
         not string.match(meta.content_sha256, '^[0-9a-f]+$') or
         meta.source_changed ~= nil then
        return {2, 'snapshot-meta-malformed'}
      end
    end
    if mode == 'manual' and meta == nil then
      return {2, 'manual-snapshot-meta-missing'}
    end
    if snapshotAction == 'set' and mode ~= 'manual' then
      return {2, 'snapshot-mode-mismatch'}
    end
    if mode == 'manual' and snapshotAction == 'keep' and not redis.call('GET', KEYS[6]) then
      return {2, 'manual-snapshot-missing'}
    end
  else
    return {2, 'entity-kind-malformed'}
  end
else
  if ARGV[3] ~= '' then return {2, 'entity-json-malformed'} end
end
local snapshotValue = nil
if snapshotAction == 'set' then
  if entityAction ~= 'set' or not ARGV[6] or ARGV[6] == '' then
    return {2, 'snapshot-value-malformed'}
  end
  local decodedSnapshot = cjson.decode(ARGV[6])
  if type(decodedSnapshot) ~= 'string' or string.len(decodedSnapshot) < 1 or
     string.len(decodedSnapshot) > ${MAX_SUBSCRIPTION_CONTENT} then
    return {2, 'snapshot-value-malformed'}
  end
  snapshotValue = decodedSnapshot
elseif ARGV[6] ~= '' then
  return {2, 'snapshot-value-unexpected'}
end
if entityAction == 'set' and ARGV[8] ~= '' then return {2, 'history-action-malformed'} end
if entityAction == 'delete' and
   (snapshotAction ~= 'delete' or healthAction ~= 'delete' or not ARGV[8] or ARGV[8] == '') then
  return {2, 'delete-actions-malformed'}
end
local fetchCacheValue = nil
local fetchCacheTtl = nil
if fetchCacheAction == 'set' then
  if entityAction ~= 'set' or entity.kind ~= 'remote' or
     (entity.refresh_mode or 'server-auto') ~= 'server-auto' or
     not isStringKey(KEYS[9]) or not ARGV[10] or ARGV[10] == '' or
     not isCanonicalUnsigned(ARGV[11]) then
    return {2, 'fetch-cache-action-malformed'}
  end
  fetchCacheTtl = tonumber(ARGV[11])
  if not fetchCacheTtl or fetchCacheTtl < 1 or fetchCacheTtl > 9007199254740990 then
    return {2, 'fetch-cache-ttl-malformed'}
  end
  local decodedCache = cjson.decode(ARGV[10])
  if type(decodedCache) ~= 'table' or type(decodedCache.content) ~= 'string' or
     string.len(decodedCache.content) > ${MAX_REMOTE_SUBSCRIPTION_BODY_BYTES} or
     not isSafeUnsignedNumber(decodedCache.fetched_at) or
     not isSafeUnsignedNumber(decodedCache.proxy_count) or
     (decodedCache.traffic ~= nil and type(decodedCache.traffic) ~= 'table') then
    return {2, 'fetch-cache-value-malformed'}
  end
  fetchCacheValue = ARGV[10]
elseif ARGV[10] ~= '' or ARGV[11] ~= '' then
  return {2, 'fetch-cache-value-unexpected'}
end

local currentRaw = redis.call('GET', KEYS[1])
local current = 0
if currentRaw then
  if not isCanonicalUnsigned(currentRaw) then return {2, 'version-malformed'} end
  current = tonumber(currentRaw)
  if not current or current > 9007199254740990 then return {2, 'version-overflow'} end
end
if not isCanonicalUnsigned(ARGV[1]) then return {2, 'expected-version-malformed'} end
local expected = tonumber(ARGV[1])
if not expected or expected > 9007199254740990 then
  return {2, 'expected-version-overflow'}
end
if current ~= expected then return {0, string.format('%.0f', current)} end

local generationRaw = redis.call('GET', KEYS[5])
if not generationRaw then generationRaw = '0' end
if not isCanonicalUnsigned(generationRaw) then
  return {2, 'ordinal-generation-malformed'}
end
if not isCanonicalUnsigned(ARGV[12]) then
  return {2, 'ordinal-expected-generation-malformed'}
end
if generationRaw ~= ARGV[12] then return {0, 'ordinal-generation-mismatch'} end
local generation = tonumber(generationRaw)
if not generation or generation > 9007199254740990 then
  return {2, 'ordinal-generation-overflow'}
end

if not isCanonicalUnsigned(ARGV[13]) or
   not isCanonicalUnsigned(ARGV[14]) or
   not isCanonicalUnsigned(ARGV[15]) then
  return {2, 'ordinal-plan-malformed'}
end
local expectedGlobalSize = tonumber(ARGV[13])
local sourceCount = tonumber(ARGV[14])
local assignmentCount = tonumber(ARGV[15])
if not expectedGlobalSize or not sourceCount or not assignmentCount or
   expectedGlobalSize > ${MAX_TOTAL_ASSIGNMENTS} or
   sourceCount > ${MAX_TOTAL_ASSIGNMENTS} or
   assignmentCount > ${MAX_TOTAL_ASSIGNMENTS} then
  return {2, 'ordinal-plan-bounds'}
end
if #KEYS ~= 9 + sourceCount then return {2, 'ordinal-key-count-malformed'} end
if redis.call('HLEN', KEYS[4]) ~= expectedGlobalSize then
  return {0, 'ordinal-size-mismatch'}
end

local all = redis.call('HGETALL', KEYS[4])
local cursor = 16
local sources = {}
local sourceLookup = {}
local sourceSizes = {}
local expectedSourceSizes = {}
local maxExistingBySource = {}
local seenExistingBySource = {}
local bases = {}
local nextCounters = {}
local sourceIndex = 1
while sourceIndex <= sourceCount do
  if not isStringKey(KEYS[9 + sourceIndex]) then
    return {2, 'ordinal-counter-wrongtype'}
  end
  local sourceKey = ARGV[cursor]
  local missingFlag = ARGV[cursor + 1]
  local expectedCounter = ARGV[cursor + 2]
  local expectedSourceSizeRaw = ARGV[cursor + 3]
  local nextCounterRaw = ARGV[cursor + 4]
  if not sourceKey or sourceKey == '' or
     (missingFlag ~= '0' and missingFlag ~= '1') or
     (missingFlag == '1' and expectedCounter ~= '') or
     (missingFlag == '0' and
       (not isCanonicalUnsigned(expectedCounter) or tonumber(expectedCounter) < 1 or
        tonumber(expectedCounter) > ${MAX_ORDINAL})) or
     not isCanonicalUnsigned(expectedSourceSizeRaw) or
     not isCanonicalUnsigned(nextCounterRaw) then
    return {2, 'ordinal-plan-malformed'}
  end
  local expectedSourceSize = tonumber(expectedSourceSizeRaw)
  local nextCounter = tonumber(nextCounterRaw)
  if not expectedSourceSize or expectedSourceSize > ${MAX_TOTAL_ASSIGNMENTS} or
     not nextCounter or nextCounter < 1 or nextCounter > ${MAX_ORDINAL} then
    return {2, 'ordinal-plan-bounds'}
  end
  local actualCounter = redis.call('GET', KEYS[9 + sourceIndex])
  if actualCounter and
     (not isCanonicalUnsigned(actualCounter) or tonumber(actualCounter) < 1 or
      tonumber(actualCounter) > ${MAX_ORDINAL}) then
    return {2, 'ordinal-counter-malformed'}
  end
  if missingFlag == '1' then
    if actualCounter then return {0, 'ordinal-counter-mismatch'} end
  elseif not actualCounter or actualCounter ~= expectedCounter then
    return {0, 'ordinal-counter-mismatch'}
  end
  if sourceLookup[sourceKey] then return {2, 'ordinal-source-duplicate'} end
  sources[sourceIndex] = sourceKey
  sourceLookup[sourceKey] = sourceIndex
  sourceSizes[sourceIndex] = 0
  expectedSourceSizes[sourceIndex] = expectedSourceSize
  maxExistingBySource[sourceIndex] = 0
  seenExistingBySource[sourceIndex] = {}
  bases[sourceIndex] = actualCounter and tonumber(actualCounter) or 0
  nextCounters[sourceIndex] = nextCounter
  cursor = cursor + 5
  sourceIndex = sourceIndex + 1
end

local pairIndex = 1
while pairIndex <= #all do
  local field = all[pairIndex]
  local colon = string.find(field, ':', 1, true)
  if colon then
    local storedSource = string.sub(field, 1, colon - 1)
    local storedSourceIndex = sourceLookup[storedSource]
    if storedSourceIndex then
      sourceSizes[storedSourceIndex] = sourceSizes[storedSourceIndex] + 1
      local stored = all[pairIndex + 1]
      if not isCanonicalUnsigned(stored) then
        return {2, 'ordinal-existing-malformed'}
      end
      local storedNumber = tonumber(stored)
      if not storedNumber or storedNumber < 1 or storedNumber > ${MAX_ORDINAL} then
        return {2, 'ordinal-existing-malformed'}
      end
      if seenExistingBySource[storedSourceIndex][stored] then
        return {2, 'ordinal-existing-duplicate'}
      end
      seenExistingBySource[storedSourceIndex][stored] = true
      if storedNumber > maxExistingBySource[storedSourceIndex] then
        maxExistingBySource[storedSourceIndex] = storedNumber
      end
    end
  end
  pairIndex = pairIndex + 2
end

sourceIndex = 1
while sourceIndex <= sourceCount do
  if sourceSizes[sourceIndex] ~= expectedSourceSizes[sourceIndex] then
    return {0, 'ordinal-source-size-mismatch'}
  end
  if maxExistingBySource[sourceIndex] > bases[sourceIndex] then
    bases[sourceIndex] = maxExistingBySource[sourceIndex]
  end
  sourceIndex = sourceIndex + 1
end

local fields = {}
local ordinals = {}
local seenFields = {}
local assignmentIndex = 1
while assignmentIndex <= assignmentCount do
  local plannedSourceRaw = ARGV[cursor]
  local field = ARGV[cursor + 1]
  local ordinalRaw = ARGV[cursor + 2]
  if not isCanonicalUnsigned(plannedSourceRaw) or not isCanonicalUnsigned(ordinalRaw) then
    return {2, 'ordinal-plan-malformed'}
  end
  local plannedSource = tonumber(plannedSourceRaw)
  local ordinal = tonumber(ordinalRaw)
  local fieldColon = field and string.find(field, ':', 1, true)
  if not plannedSource or plannedSource < 1 or plannedSource > sourceCount or
     not fieldColon or string.sub(field, 1, fieldColon - 1) ~= sources[plannedSource] or
     not ordinal or ordinal ~= bases[plannedSource] + 1 or ordinal > ${MAX_ORDINAL} then
    return {2, 'ordinal-plan-malformed'}
  end
  if seenFields[field] then return {2, 'ordinal-plan-duplicate'} end
  if redis.call('HGET', KEYS[4], field) then return {0, 'ordinal-field-exists'} end
  seenFields[field] = true
  bases[plannedSource] = ordinal
  sourceSizes[plannedSource] = sourceSizes[plannedSource] + 1
  if sourceSizes[plannedSource] > ${MAX_TOTAL_ASSIGNMENTS} or
     expectedGlobalSize + assignmentIndex > ${MAX_TOTAL_ASSIGNMENTS} then
    return {2, 'ordinal-plan-cap'}
  end
  fields[assignmentIndex] = field
  ordinals[assignmentIndex] = ordinalRaw
  cursor = cursor + 3
  assignmentIndex = assignmentIndex + 1
end
if cursor - 1 ~= #ARGV then return {2, 'argument-count-malformed'} end

sourceIndex = 1
while sourceIndex <= sourceCount do
  if bases[sourceIndex] ~= nextCounters[sourceIndex] then
    return {2, 'ordinal-counter-rollback'}
  end
  sourceIndex = sourceIndex + 1
end

local nextVersion = current + 1
assignmentIndex = 1
while assignmentIndex <= assignmentCount do
  redis.call('HSET', KEYS[4], fields[assignmentIndex], ordinals[assignmentIndex])
  assignmentIndex = assignmentIndex + 1
end
sourceIndex = 1
while sourceIndex <= sourceCount do
  redis.call('SET', KEYS[9 + sourceIndex], string.format('%.0f', nextCounters[sourceIndex]))
  sourceIndex = sourceIndex + 1
end
if assignmentCount > 0 then
  redis.call('SET', KEYS[5], string.format('%.0f', generation + 1))
end
if entityAction == 'set' then
  redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
else
  redis.call('HDEL', KEYS[2], ARGV[2])
end
if snapshotAction == 'set' then
  redis.call('SET', KEYS[6], snapshotValue)
elseif snapshotAction == 'delete' then
  redis.call('DEL', KEYS[6])
end
if healthAction == 'delete' then redis.call('DEL', KEYS[7]) end
redis.call('DEL', KEYS[8])
if fetchCacheAction == 'set' then
  redis.call('SET', KEYS[9], fetchCacheValue, 'EX', string.format('%.0f', fetchCacheTtl))
end
if entityAction == 'delete' then redis.call('HDEL', KEYS[3], ARGV[8]) end
redis.call('SET', KEYS[1], string.format('%.0f', nextVersion))
return {1, string.format('%.0f', nextVersion)}
`.trim();

export const CAS_SUBSCRIPTION_CHANGE = CAS_SUBSCRIPTION_MUTATION;
export const CAS_SUBSCRIPTION_DELETE = CAS_SUBSCRIPTION_MUTATION;

export type SubscriptionManualSnapshotAction =
  | { type: 'keep' }
  | { type: 'set'; content: string }
  | { type: 'delete' };

export interface SubscriptionCommitOptions {
  manualSnapshot?: SubscriptionManualSnapshotAction;
  clearFetchHealth?: boolean;
  fetchCache?: { cacheKey: string; entry: FetchCacheEntry; ttlMs: number };
}

export class SubscriptionCommitStateError extends Error {
  constructor() {
    super('Subscription storage state is invalid.');
    this.name = 'SubscriptionCommitStateError';
  }
}

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
// (enabled/url/policy/operators…) shape the rendered config. P-FFP v1: the
// definition row is CONFIG-ONLY — runtime fetch state (last_synced_at /
// last_traffic / last_error / refresh receipts) was retired; the separate
// subscription-fetch-health value records actual attempt health instead.

/**
 * Atomically compare config/ordinal state, apply the definition and its
 * separate-state actions, invalidate the resolved snapshot and bump the
 * generation exactly once. Render cache keys remain untouched: their embedded
 * config version makes them logically stale after success.
 */
export interface SubscriptionCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

function parseSubscriptionCommitResult(result: unknown): SubscriptionCommitResult {
  if (!Array.isArray(result) || result.length < 2) {
    throw new SubscriptionCommitStateError();
  }
  const status = Number(result[0]);
  if (status === 2 || (status !== 0 && status !== 1)) {
    throw new SubscriptionCommitStateError();
  }
  const parsedVersion = Number(result[1]);
  return {
    ok: status === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}

export async function commitSubscriptionChange(
  sub: Subscription,
  expectedVersion: number,
  ordinalPlan: OrdinalReservationPlan,
  options: SubscriptionCommitOptions = {},
): Promise<SubscriptionCommitResult> {
  const toStore = restoreRawOperators(sub);
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const snapshot = options.manualSnapshot ?? { type: 'keep' };
  if (
    snapshot.type === 'set' &&
    Buffer.byteLength(snapshot.content, 'utf8') > MAX_SUBSCRIPTION_CONTENT
  ) {
    throw new SubscriptionCommitStateError();
  }
  const snapshotValue = snapshot.type === 'set' ? safeJsonStringify(snapshot.content) : '';
  const fetchCache = options.fetchCache;
  if (
    fetchCache &&
    (!/^[0-9a-f]{16}$/.test(fetchCache.cacheKey) ||
      !Number.isSafeInteger(fetchCache.ttlMs) ||
      fetchCache.ttlMs < 1 ||
      Buffer.byteLength(fetchCache.entry.content, 'utf8') >
        MAX_REMOTE_SUBSCRIPTION_BODY_BYTES)
  ) {
    throw new SubscriptionCommitStateError();
  }
  const fetchCacheTtlSeconds = fetchCache
    ? Math.max(1, Math.ceil(fetchCache.ttlMs / 1000))
    : 0;
  const result = await getRedis().eval(
    CAS_SUBSCRIPTION_CHANGE,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.subscriptions,
      REDIS_KEYS.namingHistory,
      REDIS_KEYS.nodeOrdinals,
      REDIS_KEYS.nodeOrdinalGeneration,
      REDIS_KEYS.subscriptionManualSnapshot(toStore.id),
      REDIS_KEYS.subscriptionFetchHealth(toStore.id),
      REDIS_KEYS.resolvedSnapshot,
      REDIS_KEYS.fetchCache(fetchCache?.cacheKey ?? 'cas-noop'),
      ...encoded.counterKeys,
    ],
    [
      String(expectedVersion),
      toStore.id,
      safeJsonStringify(toStore),
      'set',
      snapshot.type,
      snapshotValue,
      options.clearFetchHealth ? 'delete' : 'keep',
      '',
      fetchCache ? 'set' : 'keep',
      fetchCache ? safeJsonStringify(fetchCache.entry) : '',
      fetchCache ? String(fetchCacheTtlSeconds) : '',
      ...encoded.args,
    ],
  );
  return parseSubscriptionCommitResult(result);
}

export async function commitSubscriptionDelete(
  id: string,
  expectedVersion: number,
  ordinalPlan: OrdinalReservationPlan,
): Promise<SubscriptionCommitResult> {
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const result = await getRedis().eval(
    CAS_SUBSCRIPTION_DELETE,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.subscriptions,
      REDIS_KEYS.namingHistory,
      REDIS_KEYS.nodeOrdinals,
      REDIS_KEYS.nodeOrdinalGeneration,
      REDIS_KEYS.subscriptionManualSnapshot(id),
      REDIS_KEYS.subscriptionFetchHealth(id),
      REDIS_KEYS.resolvedSnapshot,
      REDIS_KEYS.fetchCache('cas-noop'),
      ...encoded.counterKeys,
    ],
    [
      String(expectedVersion),
      id,
      '',
      'delete',
      'delete',
      '',
      'delete',
      `subscription:${id}`,
      'keep',
      '',
      '',
      ...encoded.args,
    ],
  );
  return parseSubscriptionCommitResult(result);
}
