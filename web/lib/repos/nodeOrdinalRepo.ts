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
 * Bounds (fail-open, never fail-closed):
 *   - an ordinal above {@link MAX_ORDINAL} is not assigned (the node falls
 *     back to input order);
 *   - when the Hash is at {@link MAX_TOTAL_ASSIGNMENTS} fields, new
 *     assignments are skipped (the node falls back to input order).
 * Both bounds keep a pathological upstream history from growing Redis
 * without bound; rendering never depends on this store succeeding.
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
 * The shared fail-open STORE READ (C6/C11): one snapshot consumed by the
 * read-only projection, mirroring exactly what the serving Lua observes.
 * WRONGTYPE state never throws and never synthesizes ordinals on one side
 * while the other falls back:
 *   - global hash WRONGTYPE (hgetall/hlen) → `hashBroken` — EVERY source
 *     falls back (serving: the eval aborts at the first HGET → fail-open
 *     empty map);
 *   - per-source counter WRONGTYPE → `counterBroken` — that source's whole
 *     allocation list falls back (serving: the eval aborts at the first
 *     missing canonical assignment's counter GET → empty map for the source;
 *     an all-canonical-existing source never touches the counter and keeps
 *     its existing values);
 *   - present-but-non-canonical existing values → `invalidFields` (rejected
 *     slots: fall back, never re-allocated).
 */
export interface OrdinalStoreSnapshot {
  assignments: OrdinalAssignments;
  invalidFields: Map<string, Set<string>>;
  counters: Map<string, string | null>;
  hashBroken: boolean;
  counterBroken: Set<string>;
  /** HLEN observed in the SAME atomic eval as the assignments + counter. */
  hlenBySource: Map<string, number>;
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
 * exactly the serving path's per-source fail-open).
 *
 * KEYS: [1] ordinal hash. ARGV: [2..] per-source counter keys.
 * Returns {0, hgetallPairs, hlen, counter1, ...} where a broken counter is
 * the nested {2, 'counter-wrongtype'}, or {2, 'hash-wrongtype'}.
 */
export const ORDINAL_SNAPSHOT_LUA = `
local hashType = redis.call('TYPE', KEYS[1]).ok
if hashType ~= 'hash' and hashType ~= 'none' then return {2, 'hash-wrongtype'} end
local h = redis.call('HGETALL', KEYS[1])
local size = redis.call('HLEN', KEYS[1])
local out = {0, h, size}
for i = 1, #ARGV do
  local counterType = redis.call('TYPE', ARGV[i]).ok
  if counterType ~= 'string' and counterType ~= 'none' then
    out[i + 3] = {2, 'counter-wrongtype'}
  else
    out[i + 3] = redis.call('GET', ARGV[i])
  end
end
return out
`.trim();

export async function readOrdinalStore(sourceKeys: string[]): Promise<OrdinalStoreSnapshot> {
  const snapshot: OrdinalStoreSnapshot = {
    assignments: new Map(),
    invalidFields: new Map(),
    counters: new Map(),
    hashBroken: false,
    counterBroken: new Set(),
    hlenBySource: new Map(),
  };
  for (const key of sourceKeys) {
    snapshot.assignments.set(key, new Map());
    snapshot.invalidFields.set(key, new Set());
  }
  if (sourceKeys.length === 0) return snapshot;
  let result: unknown;
  try {
    result = await getRedis().eval(
      ORDINAL_SNAPSHOT_LUA,
      [REDIS_KEYS.nodeOrdinals],
      sourceKeys.map((key) => REDIS_KEYS.nodeOrdinalCounter(key)),
    );
  } catch {
    // a real eval error: treat the shared hash as broken (every source falls
    // back — the serving path fail-opens the same way)
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
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const field = String(pairs[i]);
    const value = String(pairs[i + 1]);
    const colon = field.indexOf(':');
    if (colon === -1) continue;
    const sourceKey = field.slice(0, colon);
    const fingerprint = field.slice(colon + 1);
    const bucket = snapshot.assignments.get(sourceKey);
    if (!bucket) continue;
    const ordinal = canonicalOrdinalValue(value);
    if (ordinal !== null) bucket.set(fingerprint, ordinal);
    else snapshot.invalidFields.get(sourceKey)?.add(fingerprint);
  }
  const hlen = Number(result[2] ?? 0);
  const safeHlen = Number.isSafeInteger(hlen) && hlen >= 0 ? hlen : 0;
  sourceKeys.forEach((key, i) => {
    const entry = result[3 + i];
    if (Array.isArray(entry) && entry[0] === 2 && entry[1] === 'counter-wrongtype') {
      snapshot.counterBroken.add(key);
      snapshot.counters.set(key, null);
      return;
    }
    snapshot.hlenBySource.set(key, safeHlen);
    snapshot.counters.set(key, entry === null || entry === undefined ? null : String(entry));
  });
  return snapshot;
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
 *   - absent / empty / malformed / non-integer / beyond the JS-safe range
 *     → base 0 (self-healing: the next accepted allocation canonicalizes the
 *       store);
 *   - negative → base stays negative → next ≤ 0 → REJECTED (fallback), no
 *     store write — the store never accumulates rejected values;
 *   - next > MAX_ORDINAL → REJECTED (fallback), no store write.
 * The hash cap is checked BEFORE the counter parse (same order as the Lua).
 */
export function parseOrdinalCounter(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!/^-?[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/** One allocation decision. `hashSize` must be the CURRENT hash size (for a
 * projection: initial HLEN + accepted assignments so far). Returns the
 * ordinal to persist, or null when the node falls back to input order. */
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
local hashCap = tonumber(ARGV[1])
local maxOrd = tonumber(ARGV[2])
local function isCanonicalUnsigned(raw)
  if type(raw) ~= 'string' then return false end
  if not string.match(raw, '^[0-9]+$') then return false end
  if string.len(raw) > 1 and string.sub(raw, 1, 1) == '0' then return false end
  return true
end
local results = {}
for i = 3, #ARGV do
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
    local hlen = redis.call('HLEN', hashKey)
    local counterRaw = redis.call('GET', counterKey)
    local base = 0
    if counterRaw and string.match(counterRaw, '^-?[0-9]+$') then
      base = tonumber(counterRaw)
      if not base or base > 9007199254740991 or base < -9007199254740991 then base = 0 end
    end
    local ordinal = base + 1
    if hlen + 1 <= hashCap and ordinal >= 1 and ordinal <= maxOrd then
      -- SET the exact computed value (never INCR: a counter INCR could raise
      -- on overflow/non-integer AFTER an earlier HSET in the same eval).
      redis.call('SET', counterKey, string.format('%.0f', ordinal))
      redis.call('HSET', hashKey, field, string.format('%.0f', ordinal))
      results[#results + 1] = ordinal
      accepted = true
    end
  end
  if not accepted then
    results[#results + 1] = ''
  end
end
return results
`.trim();

export async function assignOrdinals(
  sourceKey: string,
  fingerprints: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (fingerprints.length === 0) return out;
  const client = getRedis();
  const args: string[] = [
    String(MAX_TOTAL_ASSIGNMENTS),
    String(MAX_ORDINAL),
    ...fingerprints.map((fp) => fieldKey(sourceKey, fp)),
  ];
  // Fail-open by contract ("rendering never depends on this store"): a
  // corrupt store (wrong-type hash/counter key) degrades to empty assignments
  // (every node falls back to input order) instead of failing the render.
  let results: unknown[];
  try {
    results = (await client.eval(
      ASSIGN_ORDINALS_LUA,
      [REDIS_KEYS.nodeOrdinals, REDIS_KEYS.nodeOrdinalCounter(sourceKey)],
      args,
    )) as unknown[];
  } catch {
    return out;
  }
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

/** Wipe the store (tests / explicit admin). Never called by render paths. */
export async function clearOrdinalAssignments(): Promise<void> {
  await getRedis().del(REDIS_KEYS.nodeOrdinals);
}
