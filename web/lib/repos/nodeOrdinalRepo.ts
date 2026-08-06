/**
 * Persisted stable node-ordinal assignments (managed naming, ${index}).
 *
 * Criterion: stable numbering must not churn merely because upstream order
 * changes. Upstream ordinals ("香港 01") cover suffixed nodes; the remaining
 * nodes get a SERVER-SIDE assignment here — one Redis Hash field per
 * `${sourceKey}:${nodeFingerprint}`, with per-source INCR counters — so the
 * assignment is monotonic NON-REUSE: a fingerprint keeps its ordinal forever,
 * and a freed ordinal is never handed to a different node.
 *
 * Allocation is a single atomic Lua eval (get-or-assign per fingerprint):
 * concurrent renders all receive the SAME authoritative ordinal for a
 * fingerprint, and the persisted winner is always what was served — no
 * caller ever uses a local pre-write guess.
 *
 * Bounds (fail-closed at the naming-service boundary):
 *   - an ordinal above {@link MAX_ORDINAL} is not assigned;
 *   - when the Hash is at {@link MAX_TOTAL_ASSIGNMENTS} fields, new
 *     assignments are skipped.
 * The low-level repository reports either condition as an incomplete result;
 * nodeOrdinalService treats that signal as a fatal planning error so a saved
 * `${index}` policy never silently churns back to input-order numbering.
 *
 * The assignments are internal serving state: fingerprints are canonical
 * config hashes that never leave the server, and the repo is never part of
 * any public or assistant payload. Preview and save-preflight paths MUST NOT
 * call assignOrdinals — they resolve the read-only snapshot only
 * (nodeOrdinalService), so an abandoned candidate can never change what is
 * served.
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

/** Upper bound on a single ordinal (INCR counter cap). */
export const MAX_ORDINAL = 99_999;
/** Upper bound on the total assignment hash size. */
export const MAX_TOTAL_ASSIGNMENTS = 20_000;

export type OrdinalAssignments = Map<string, Map<string, number>>;

function fieldKey(sourceKey: string, fingerprint: string): string {
  return `${sourceKey}:${fingerprint}`;
}

/**
 * Load every persisted assignment for the given source keys (one HGETALL).
 * Missing keys yield empty maps. Read-only — safe on every path.
 */
/** Strict canonical stored-ordinal validation (NOT parseInt): canonical
 * decimal, no leading zeros, within 1..maxOrdinal. Anything else — empty,
 * negative, decimal, suffix garbage, leading zeros, MAX_ORDINAL overflow —
 * is a REJECTED slot on both serving and read-only paths. */
export function canonicalOrdinalValue(
  raw: string,
  maxOrdinal: number = MAX_ORDINAL,
): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maxOrdinal) return null;
  return value;
}

/**
 * Load every CANONICAL persisted assignment for the given source keys (one
 * HGETALL). Non-canonical stored values are ignored here — they are tracked
 * as REJECTED slots by {@link readOrdinalStore}; this legacy helper stays
 * strict-canonical for compatibility callers. Read-only — safe on every path.
 */
export async function loadOrdinalAssignments(sourceKeys: string[]): Promise<OrdinalAssignments> {
  const out: OrdinalAssignments = new Map();
  for (const key of sourceKeys) out.set(key, new Map());
  if (sourceKeys.length === 0) return out;
  const raw = await getRedis().hgetall<Record<string, string>>(REDIS_KEYS.nodeOrdinals);
  if (!raw) return out;
  for (const [field, value] of Object.entries(raw)) {
    const colon = field.indexOf(':');
    if (colon === -1) continue;
    const sourceKey = field.slice(0, colon);
    const fingerprint = field.slice(colon + 1);
    const bucket = out.get(sourceKey);
    if (!bucket) continue;
    const ordinal = canonicalOrdinalValue(value);
    if (ordinal !== null) bucket.set(fingerprint, ordinal);
  }
  return out;
}

/**
 * The shared STORE READ (C6/C11): one snapshot consumed by the
 * read-only projection, mirroring exactly what the serving Lua observes.
 * WRONGTYPE state never throws and never synthesizes ordinals on one side
 * while the other falls back:
 *   - global hash WRONGTYPE (hgetall/hlen) → `hashBroken` — EVERY source
 *     is marked broken (the naming service fails closed);
 *   - per-source counter WRONGTYPE → `counterBroken` — that source's whole
 *     allocation list is marked broken;
 *   - present-but-non-canonical existing values → `invalidFields` (rejected
 *     slots, never re-allocated). Every broken/incomplete state is rejected
 *     by nodeOrdinalService before names are rendered.
 */
export interface OrdinalStoreSnapshot {
  assignments: OrdinalAssignments;
  invalidFields: Map<string, Set<string>>;
  /** A source contains two canonical fingerprints with the same ordinal. */
  duplicateSources: Set<string>;
  counters: Map<string, string | null>;
  hashBroken: boolean;
  counterBroken: Set<string>;
  /** HLEN observed in the SAME atomic eval as the assignments + counter. */
  hlenBySource: Map<string, number>;
  /** Global HLEN from the same snapshot (hard resource bound). */
  globalSize: number;
  /** Global allocation generation from the same atomic snapshot. */
  generation: number | null;
}

/**
 * ONE atomic read-only snapshot of the WHOLE ordinal store (pass-3 finding):
 * a single Redis eval returns the shared hash (flat HGETALL pairs), its HLEN
 * and EVERY requested per-source counter from the SAME instant — a preview
 * spanning multiple sources can never mix a pre-allocation hash/counter with
 * a post-allocation one (the earlier per-source evals could: a later source's
 * eval saw newer hash state while earlier counters stayed old). The hash is
 * parsed exactly once by the caller. WRONGTYPE is prevalidated inside the
 * script with per-counter classification (a wrongtype counter yields a
 * per-source marker while the rest of the snapshot is still returned —
 * exactly the serving path's per-source classification).
 *
 * KEYS: [1] ordinal hash. ARGV: [2..] per-source counter keys.
 * Returns {0, hgetallPairs, hlen, counter1, ...} where a broken counter is
 * the nested {2, 'counter-wrongtype'}, or {2, 'hash-wrongtype'}.
 */
export const ORDINAL_SNAPSHOT_LUA = `
local hashType = redis.call('TYPE', KEYS[1]).ok
if hashType ~= 'hash' and hashType ~= 'none' then return {2, 'hash-wrongtype'} end
local generationType = redis.call('TYPE', KEYS[2]).ok
if generationType ~= 'string' and generationType ~= 'none' then
  return {2, 'generation-wrongtype'}
end
local h = redis.call('HGETALL', KEYS[1])
local size = redis.call('HLEN', KEYS[1])
local generation = redis.call('GET', KEYS[2])
local out = {0, h, size, generation}
for i = 1, #ARGV do
  local counterType = redis.call('TYPE', ARGV[i]).ok
  if counterType ~= 'string' and counterType ~= 'none' then
    out[i + 4] = {2, 'counter-wrongtype'}
  else
    out[i + 4] = redis.call('GET', ARGV[i])
  end
end
return out
`.trim();

export async function readOrdinalStore(sourceKeys: string[]): Promise<OrdinalStoreSnapshot> {
  const snapshot: OrdinalStoreSnapshot = {
    assignments: new Map(),
    invalidFields: new Map(),
    duplicateSources: new Set(),
    counters: new Map(),
    hashBroken: false,
    counterBroken: new Set(),
    hlenBySource: new Map(),
    globalSize: 0,
    generation: null,
  };
  for (const key of sourceKeys) {
    snapshot.assignments.set(key, new Map());
    snapshot.invalidFields.set(key, new Set());
    snapshot.hlenBySource.set(key, 0);
  }
  let result: unknown;
  try {
    result = await getRedis().eval(
      ORDINAL_SNAPSHOT_LUA,
      [REDIS_KEYS.nodeOrdinals, REDIS_KEYS.nodeOrdinalGeneration],
      sourceKeys.map((key) => REDIS_KEYS.nodeOrdinalCounter(key)),
    );
  } catch {
    // a real eval error: treat the shared hash as broken (every source falls
    // back — the naming service rejects the broken snapshot)
    snapshot.hashBroken = true;
    return snapshot;
  }
  if (!Array.isArray(result)) {
    snapshot.hashBroken = true;
    return snapshot;
  }
  if (result[0] === 2) {
    if (result[1] === 'hash-wrongtype') snapshot.hashBroken = true;
    return snapshot;
  }
  // parse the shared hash EXACTLY ONCE
  const pairs = (result[1] ?? []) as unknown[];
  const seenOrdinals = new Map<string, Set<number>>();
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const field = String(pairs[i]);
    const value = String(pairs[i + 1]);
    const colon = field.indexOf(':');
    if (colon === -1) continue;
    const sourceKey = field.slice(0, colon);
    const fingerprint = field.slice(colon + 1);
    const bucket = snapshot.assignments.get(sourceKey);
    if (!bucket) continue;
    snapshot.hlenBySource.set(sourceKey, (snapshot.hlenBySource.get(sourceKey) ?? 0) + 1);
    const ordinal = canonicalOrdinalValue(value);
    if (ordinal !== null) {
      const seen = seenOrdinals.get(sourceKey) ?? new Set<number>();
      if (seen.has(ordinal)) snapshot.duplicateSources.add(sourceKey);
      seen.add(ordinal);
      seenOrdinals.set(sourceKey, seen);
      bucket.set(fingerprint, ordinal);
    } else snapshot.invalidFields.get(sourceKey)?.add(fingerprint);
  }
  snapshot.generation = canonicalGeneration(result[3]);
  const globalSize = Number(result[2] ?? 0);
  snapshot.globalSize = Number.isSafeInteger(globalSize) && globalSize >= 0 ? globalSize : 0;
  sourceKeys.forEach((key, i) => {
    const entry = result[4 + i];
    if (Array.isArray(entry) && entry[0] === 2 && entry[1] === 'counter-wrongtype') {
      snapshot.counterBroken.add(key);
      snapshot.counters.set(key, null);
      return;
    }
    snapshot.counters.set(key, entry === null || entry === undefined ? null : String(entry));
  });
  return snapshot;
}

/** Strict generation parse. Missing is the initial generation zero. */
export function canonicalGeneration(raw: unknown): number | null {
  if (raw === null || raw === undefined) return 0;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text);
  // Every mutation of this generation increments it in the same atomic Lua
  // transition. Reject MAX_SAFE_INTEGER at the read boundary as well, so a
  // preview cannot approve a snapshot that serving/CAS/clear cannot advance.
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 1
    ? value
    : null;
}

/** Read the allocation generation for a save bracket. */
export async function getOrdinalGeneration(): Promise<number | null> {
  try {
    return canonicalGeneration(await getRedis().get<unknown>(REDIS_KEYS.nodeOrdinalGeneration));
  } catch {
    return null;
  }
}

/**
 * Atomic get-or-assign: for every fingerprint in order, return the EXISTING
 * assignment, or INCR the per-source counter and HSET once inside the same
 * eval. All callers (render / export / collection stage) use the returned
 * authoritative values — a fingerprint's ordinal is identical no matter who
 * asks. Returns fp → ordinal; fingerprints that hit a bound are absent
 * (callers fall back to input order).
 *
 * ARGV layout: [1] total-hash cap, [2] max ordinal, [3..] field keys.
 * Results are pushed densely (a hole-free Lua array) so Redis serializes
 * every entry at its exact position.
 */
/**
 * THE shared allocation state machine (C6/C11). The serving Lua below is a
 * byte-level mirror of this function: same check order (existing assignment
 * is resolved by callers first, then the hash cap, then the value), same
 * canonical counter parse, same fallback decisions. Every read-only
 * projection calls this function; every serving render runs the Lua. A state
 * that differs here must differ identically in the Lua — the parity suite
 * (tests/services/namingParity.test.ts) proves it over the whole matrix.
 *
 * Counter semantics (identical on both sides):
 *   - absent / empty / malformed / signed / leading-zero / beyond the
 *     JS-safe range
 *     → base 0 (self-healing: the next accepted allocation canonicalizes the
 *       store);
 *   - next > MAX_ORDINAL → REJECTED (fallback), no store write.
 * The hash cap is checked BEFORE the counter parse (same order as the Lua).
 */
export function parseOrdinalCounter(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** One allocation decision. `hashSize` must be the CURRENT hash size (for a
 * projection: initial HLEN + accepted assignments so far). Returns the
 * ordinal to persist, or null as a fail-closed rejection signal. */
export function allocateOrdinal(
  counterRaw: string | null | undefined,
  hashSize: number,
  options?: { hashCap?: number; maxOrdinal?: number },
): number | null {
  const hashCap = options?.hashCap ?? MAX_TOTAL_ASSIGNMENTS;
  const maxOrdinal = options?.maxOrdinal ?? MAX_ORDINAL;
  if (hashSize + 1 > hashCap) return null;
  const base = parseOrdinalCounter(counterRaw) ?? 0;
  const next = base + 1;
  if (next < 1 || next > maxOrdinal) return null;
  return next;
}

/** Exported for the Lua-semantics test harness (no live Redis in CI). */
export const ASSIGN_ORDINALS_LUA = `
local hashKey = KEYS[1]
local counterKey = KEYS[2]
local configVersionKey = KEYS[3]
local generationKey = KEYS[4]
local hashCap = tonumber(ARGV[1])
local maxOrd = tonumber(ARGV[2])
local expectedVersion = ARGV[3]
local sourcePrefix = ARGV[4]
local function isCanonicalUnsigned(raw)
  if type(raw) ~= 'string' then return false end
  if not string.match(raw, '^[0-9]+$') then return false end
  if string.len(raw) > 1 and string.sub(raw, 1, 1) == '0' then return false end
  return true
end
local hashType = redis.call('TYPE', hashKey).ok
local counterType = redis.call('TYPE', counterKey).ok
local versionType = redis.call('TYPE', configVersionKey).ok
local generationType = redis.call('TYPE', generationKey).ok
if hashType ~= 'hash' and hashType ~= 'none' then return {'__error__', 'hash-wrongtype'} end
if counterType ~= 'string' and counterType ~= 'none' then return {'__error__', 'counter-wrongtype'} end
if versionType ~= 'string' and versionType ~= 'none' then return {'__error__', 'version-wrongtype'} end
if generationType ~= 'string' and generationType ~= 'none' then
  return {'__error__', 'generation-wrongtype'}
end
local currentVersion = redis.call('GET', configVersionKey)
if not currentVersion then currentVersion = '0' end
if not isCanonicalUnsigned(currentVersion) or currentVersion ~= expectedVersion then
  return {'__error__', 'stale-config'}
end
local generationRaw = redis.call('GET', generationKey)
if not generationRaw then generationRaw = '0' end
if not isCanonicalUnsigned(generationRaw) then return {'__error__', 'generation-malformed'} end
local generation = tonumber(generationRaw)
if not generation or generation > 9007199254740990 then
  return {'__error__', 'generation-overflow'}
end
-- Repair a missing/stale counter from the canonical maximum already assigned
-- to THIS source. The global hash is bounded at 20k, so this migration-safe
-- scan is deterministic and cannot reissue an existing ordinal.
local maxExisting = 0
local sourceSize = 0
local seenExisting = {}
local globalSize = redis.call('HLEN', hashKey)
local all = redis.call('HGETALL', hashKey)
local allIndex = 1
while allIndex <= #all do
  local field = all[allIndex]
  local stored = all[allIndex + 1]
  if string.sub(field, 1, string.len(sourcePrefix)) == sourcePrefix then
    sourceSize = sourceSize + 1
    if isCanonicalUnsigned(stored) then
      local n = tonumber(stored)
      if n and n >= 1 and n <= maxOrd then
        if seenExisting[stored] then return {'__error__', 'ordinal-existing-duplicate'} end
        seenExisting[stored] = true
        if n > maxExisting then maxExisting = n end
      end
    end
  end
  allIndex = allIndex + 2
end
local counterRaw = redis.call('GET', counterKey)
local base = maxExisting
if counterRaw and isCanonicalUnsigned(counterRaw) then
  local parsed = tonumber(counterRaw)
  if parsed and parsed <= 9007199254740991 and parsed > base then base = parsed end
end
local results = {}
local wrote = false
for i = 5, #ARGV do
  local field = ARGV[i]
  local existing = redis.call('HGET', hashKey, field)
  local accepted = false
  if existing then
    -- canonical existing wins; a PRESENT non-canonical value (empty,
    -- negative, decimal, suffix garbage, leading zeros, out of range) is a
    -- REJECTED slot: fall back WITHOUT allocating and WITHOUT reading the
    -- counter (mirror of canonicalOrdinalValue on the read-only side).
    if isCanonicalUnsigned(existing) then
      local n = tonumber(existing)
      if n and n >= 1 and n <= maxOrd then
        results[#results + 1] = existing
        accepted = true
      end
    end
  else
    local ordinal = base + 1
    if globalSize + 1 <= hashCap and sourceSize + 1 <= hashCap and ordinal >= 1 and ordinal <= maxOrd then
      redis.call('HSET', hashKey, field, string.format('%.0f', ordinal))
      results[#results + 1] = ordinal
      base = ordinal
      sourceSize = sourceSize + 1
      globalSize = globalSize + 1
      wrote = true
      accepted = true
    end
  end
  if not accepted then
    results[#results + 1] = ''
  end
end
if wrote then
  redis.call('SET', counterKey, string.format('%.0f', base))
  redis.call('SET', generationKey, string.format('%.0f', generation + 1))
end
return results
`.trim();

export async function assignOrdinals(
  sourceKey: string,
  fingerprints: string[],
  expectedConfigVersion: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (fingerprints.length === 0) return out;
  const client = getRedis();
  const args: string[] = [
    String(MAX_TOTAL_ASSIGNMENTS),
    String(MAX_ORDINAL),
    String(expectedConfigVersion),
    `${sourceKey}:`,
    ...fingerprints.map((fp) => fieldKey(sourceKey, fp)),
  ];
  // The repository converts Redis/script failures to an incomplete result;
  // nodeOrdinalService compares its size with the complete requested domain
  // and fails closed before rendering a saved `${index}` policy.
  let results: unknown[];
  try {
    results = (await client.eval(
      ASSIGN_ORDINALS_LUA,
      [
        REDIS_KEYS.nodeOrdinals,
        REDIS_KEYS.nodeOrdinalCounter(sourceKey),
        REDIS_KEYS.configVersion,
        REDIS_KEYS.nodeOrdinalGeneration,
      ],
      args,
    )) as unknown[];
  } catch {
    return out;
  }
  if (results[0] === '__error__') return out;
  fingerprints.forEach((fp, i) => {
    const value = results?.[i];
    // Newly allocated ordinals come back as Lua numbers; existing HGET
    // assignments as strings — both are authoritative.
    const ordinal =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : NaN;
    if (Number.isInteger(ordinal) && ordinal > 0 && ordinal <= MAX_ORDINAL) {
      out.set(fp, ordinal);
    }
  });
  return out;
}

export const CLEAR_ORDINALS_LUA = `
local hashType = redis.call('TYPE', KEYS[1]).ok
local generationType = redis.call('TYPE', KEYS[2]).ok
if hashType ~= 'hash' and hashType ~= 'none' then return {2, 'hash-wrongtype'} end
if generationType ~= 'string' and generationType ~= 'none' then return {2, 'generation-wrongtype'} end
local generationRaw = redis.call('GET', KEYS[2])
if not generationRaw then generationRaw = '0' end
if not string.match(generationRaw, '^[0-9]+$') or
   (string.len(generationRaw) > 1 and string.sub(generationRaw, 1, 1) == '0') then
  return {2, 'generation-malformed'}
end
local generation = tonumber(generationRaw)
if not generation or generation > 9007199254740990 then return {2, 'generation-overflow'} end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], string.format('%.0f', generation + 1))
return {1, string.format('%.0f', generation + 1)}
`.trim();

/** Wipe assignments without resetting the monotonic generation (no ABA). */
export async function clearOrdinalAssignments(): Promise<void> {
  await getRedis().eval(
    CLEAR_ORDINALS_LUA,
    [REDIS_KEYS.nodeOrdinals, REDIS_KEYS.nodeOrdinalGeneration],
    [],
  );
}
