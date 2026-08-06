/**
 * Atomic naming apply/rollback commit — ONE Redis CAS transaction.
 *
 * The config record, config:version AND the naming-history set/clear move in
 * a SINGLE eval (C8/C14): either all three change or none do. Redis does NOT
 * roll back earlier commands on a Lua runtime error, so the script
 * prevalidates EVERY failure surface before the first mutation — key types
 * (entity hash / history hash / version string), the canonical increment-safe
 * version value, and the CAS match. All subsequent commands (HSET/HDEL/SET of
 * precomputed canonical strings) are then infallible, and the version is
 * SET to the exact computed string (never INCR — INCR can raise on an
 * overflow/non-integer AFTER an earlier HSET, which would leave entity and
 * history written under an unbumped version). A wrongtype/malformed/overflow
 * version fails the script WITHOUT any write. Callers bracket the whole
 * read→candidate→discovery→preflight chain with the same planning version
 * (commitUnderPipelineGate) exactly like every other render-affecting save.
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { containsSensitivePattern, redactSensitiveText } from '@/lib/proxies/namingSanitize';
import { NamingAuditEventSchema } from '@/schemas/audit';

export interface NamingHistoryCommit {
  op: 'set' | 'del';
  /** `${type}:${id}` field in the naming-history hash. */
  field: string;
  /** JSON plan payload (op=set). */
  value?: string;
}

export interface NamingCasResult {
  ok: boolean;
  currentVersion: number | null;
  /** Prevalidation failure class — the script returned before any write. */
  failure?:
    | 'entity-wrongtype'
    | 'history-wrongtype'
    | 'version-wrongtype'
    | 'version-malformed'
    | 'version-overflow'
    | 'audit-id-exists'
    | 'profile-missing'
    | 'profile-binding-mismatch';
}

/**
 * KEYS: [1] config:version, [2] entity hash (subscriptions|collections),
 *       [3] naming-history hash, [4] audit-events zset, [5] audit-by-id hash,
 *       [6] profiles hash, [7] collections hash.
 * ARGV: [1] expected version, [2] record id, [3] record JSON,
 *       [4] history op ('' | 'set' | 'del'), [5] history field, [6] history value,
 *       [7] audit op ('' | 'set'), [8] audit event id, [9] audit ts (score),
 *       [10] audit event JSON, [11] caller profile id, [12] expected profile
 *       source type (`none` | `subscription` | `collection`), [13] expected
 *       source id ('' when type is 'none'), [14] expected collection member
 *       COUNT, [15..14+n] the gate-captured member ids in record order
 *       ('' count when the binding is not a collection). pass-8 blocker 6:
 *       for collection bindings the CAS re-validates the collection's
 *       CURRENT subscription_ids positionally inside the same atomic eval —
 *       member add/delete/reorder between gate and commit fails with
 *       NOTHING written (member rename/disable are render-affecting and are
 *       closed by the version CAS + the JS-side membership recheck).
 *
 * ORDER OF OPERATIONS (C14): every TYPE and VALUE precondition is proven
 * BEFORE the first mutation; the write phase then runs infallible commands —
 * HSET entity, HSET/HDEL history, ZADD+HSET audit, SET version (the exact
 * canonical next-version string, formatted with %.0f — never tostring, whose
 * scientific notation could corrupt the boundary). A failure at ANY point
 * returns {2, <reason>} with NOTHING written — the durable audit record is
 * part of the same atomic transition, so an audit failure can never leave
 * config committed without its event.
 *
 * Lua-valid canonical unsigned decimal (Lua patterns have NO alternation —
 * a JS-style '|' inside a pattern is a literal character): digits only, and
 * no leading zero beyond a bare "0".
 */
export const CAS_ENTITY_WITH_HISTORY = `
local function isHashKey(key)
  local t = redis.call('TYPE', key).ok
  return t == 'hash' or t == 'none'
end
local function isStringKey(key)
  local t = redis.call('TYPE', key).ok
  return t == 'string' or t == 'none'
end
local function isZsetKey(key)
  local t = redis.call('TYPE', key).ok
  return t == 'zset' or t == 'none'
end
local function isCanonicalUnsigned(raw)
  if type(raw) ~= 'string' then return false end
  if not string.match(raw, '^[0-9]+$') then return false end
  if string.len(raw) > 1 and string.sub(raw, 1, 1) == '0' then return false end
  return true
end
if not isHashKey(KEYS[2]) then return {2, 'entity-wrongtype'} end
if not isHashKey(KEYS[3]) then return {2, 'history-wrongtype'} end
if not isStringKey(KEYS[1]) then return {2, 'version-wrongtype'} end
if not isZsetKey(KEYS[4]) then return {2, 'audit-events-wrongtype'} end
if not isHashKey(KEYS[5]) then return {2, 'audit-byid-wrongtype'} end
-- pass-7 blocker 4: the CAS re-validates the caller profile's CURRENT
-- source binding inside the SAME atomic eval (not merely version + audit
-- profileId) — a rebind between the confirmation gate and this commit
-- fails with NOTHING written, even if config:version was captured stale.
local profileRaw = redis.call('HGET', KEYS[6], ARGV[11])
if type(profileRaw) ~= 'string' or profileRaw == '' then
  return {2, 'profile-missing'}
end
local ok, profile = pcall(cjson.decode, profileRaw)
if not ok or type(profile) ~= 'table' or type(profile.source) ~= 'table' then
  return {2, 'profile-binding-mismatch'}
end
-- ARGV[12] = expected source type ('none' | 'subscription' | 'collection'),
-- ARGV[13] = expected source id ('' when type is 'none'). No string
-- concatenation: the 5.1 harness subset forbids '..'.
local bindingOk = false
if ARGV[12] == 'none' then
  if profile.source.type == 'none' then bindingOk = true end
elseif type(profile.source.type) == 'string' and type(profile.source.id) == 'string' then
  if profile.source.type == ARGV[12] and profile.source.id == ARGV[13] then bindingOk = true end
end
if not bindingOk then
  return {2, 'profile-binding-mismatch'}
end
-- pass-8 blocker 6: for collection bindings, re-validate the collection's
-- CURRENT member list inside the same eval — member add/delete/reorder
-- between gate and commit fails with NOTHING written. The expected form is
-- a deterministic sorted comma-join of subscription_ids (duplicates
-- in record order, duplicates preserved). ARGV[14] = '' for non-collection
-- bindings (no member check). Count+list form: ARGV[14]=count, ids follow.
if ARGV[12] == 'collection' then
  local colRaw = redis.call('HGET', KEYS[7], ARGV[13])
  if type(colRaw) ~= 'string' or colRaw == '' then
    return {2, 'profile-binding-mismatch'}
  end
  local colOk, col = pcall(cjson.decode, colRaw)
  if not colOk or type(col) ~= 'table' or type(col.subscription_ids) ~= 'table' then
    return {2, 'profile-binding-mismatch'}
  end
  -- pass-8 blocker 6: re-validate the CURRENT member list positionally —
  -- ARGV[14] = member count, ARGV[15..14+n] = the gate-captured ids in
  -- record order (the 5.1 harness subset forbids '..', table.sort, ipairs).
  -- Any add/delete/reorder between gate and commit fails with NOTHING
  -- written; duplicates are preserved by the positional comparison.
  local expectedCount = tonumber(ARGV[14])
  if not expectedCount or expectedCount < 0 or expectedCount > 9007199254740991 then
    return {2, 'profile-binding-mismatch'}
  end
  if #col.subscription_ids ~= expectedCount then
    return {2, 'profile-binding-mismatch'}
  end
  for i = 1, expectedCount do
    if col.subscription_ids[i] ~= ARGV[14 + i] then
      return {2, 'profile-binding-mismatch'}
    end
  end
end
if ARGV[7] == 'set' then
  -- Lua-side audit defense (pass-3 finding): a fallible ZADD/HSET argument
  -- can never fail AFTER entity/history writes — the id charset and the
  -- finite score are proven here, before any mutation.
  if not string.match(ARGV[8], '^[0-9a-fA-F-]+$') or string.len(ARGV[8]) > 64 then
    return {2, 'audit-id-invalid'}
  end
  local score = tonumber(ARGV[9])
  if not score or score ~= score or score < 0 or score > 9007199254740991 then
    return {2, 'audit-score-invalid'}
  end
  if string.len(ARGV[10]) > 8192 then return {2, 'audit-payload-oversize'} end
  -- Reuse check IN the same atomic eval (pass-1 finding): the id must not
  -- already exist in the audit-by-id hash. The TypeScript side probes before
  -- the eval, but a UUID could become occupied BETWEEN that probe and this
  -- script — only this pre-write HEXISTS closes the race, and it runs before
  -- the first mutation so a reused id writes NOTHING and never overwrites
  -- the existing event.
  if redis.call('HEXISTS', KEYS[5], ARGV[8]) == 1 then
    return {2, 'audit-id-exists'}
  end
end
local currentRaw = redis.call('GET', KEYS[1])
local current = 0
if currentRaw and currentRaw ~= '' then
  -- canonical: no leading zeros, decimal digits only (Redis int64 max and
  -- 2^53 both FAIL here — they are not canonical JS-safe integers)
  if not isCanonicalUnsigned(currentRaw) then return {2, 'version-malformed'} end
  current = tonumber(currentRaw)
  -- the exact next version must remain <= Number.MAX_SAFE_INTEGER:
  -- current 2^53-1 would increment to 2^53 (not exactly representable /
  -- %.0f would round) and must FAIL BEFORE any write
  if not current or current > 9007199254740990 then return {2, 'version-overflow'} end
end
local expected = tonumber(ARGV[1])
if not expected or current ~= expected then
  return {0, string.format('%.0f', current)}
end
local nextVersion = current + 1
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
if ARGV[4] == 'set' then
  redis.call('HSET', KEYS[3], ARGV[5], ARGV[6])
elseif ARGV[4] == 'del' then
  redis.call('HDEL', KEYS[3], ARGV[5])
end
if ARGV[7] == 'set' then
  redis.call('ZADD', KEYS[4], ARGV[9], ARGV[8])
  redis.call('HSET', KEYS[5], ARGV[8], ARGV[10])
end
redis.call('SET', KEYS[1], string.format('%.0f', nextVersion))
return {1, string.format('%.0f', nextVersion)}
`.trim();

/** Strict canonical UUID (v4-shaped, hex + dashes only). */
const AUDIT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** MAX serialized audit payload (defense against oversized inputs). */
const MAX_AUDIT_PAYLOAD_BYTES = 8192;
const MAX_AUDIT_ACTOR = 64;
const MAX_AUDIT_SCORE = 9007199254740991; // Number.MAX_SAFE_INTEGER

/** Sanitization-stability: a field is sanitized iff redaction + whitespace
 * collapse leave it unchanged (the service builder's sanitizeStorageText). */
function isSanitizedStable(value: string): boolean {
  return redactSensitiveText(value).replace(/\s+/g, ' ').trim() === value;
}

/**
 * Deep per-string gate over the audit payload (pass-1 finding): EVERY
 * persisted string — including nested object/array members — must be
 * sanitization-stable, bounded, and free of credential-shaped material.
 * The three identifier slots (the event's own id, the bound entity id and
 * the bound profile id) and the schema-ENUM allowlisted literals (op /
 * target.kind / target.type / after.mode — fixed enumerations that can never
 * carry free text) are exempt from the sensitive-material check: the strict
 * schema is their allowlist, and each identifier is additionally bound to
 * the transition below.
 */
const MAX_AUDIT_STRING = 512;
const MAX_AUDIT_DEPTH = 8;
const ALLOWED_LITERAL_PATHS = new Set([
  'id',
  'target.id',
  'profileId',
  'op',
  'target.kind',
  'target.type',
  'after.mode',
]);

function assertPayloadStringsClean(value: unknown, path: string, depth: number): void {
  if (depth > MAX_AUDIT_DEPTH) {
    throw new Error('namingCasRepo: audit payload nesting exceeds bound');
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length > MAX_AUDIT_STRING) {
      throw new Error(`namingCasRepo: audit string at ${path} exceeds size bound`);
    }
    // RAW placeholder DSL text fails closed ANYWHERE in the payload (pass-2
    // finding): the persisted naming audit must never carry a raw template
    // string, so '${' is rejected before the per-slot exemptions.
    if (value.includes('${')) {
      throw new Error(`namingCasRepo: audit string at ${path} carries raw placeholder DSL`);
    }
    // identifier/enum slots are schema-validated; every OTHER string must
    // be sanitization-stable AND free of credential material (URLs, addresses,
    // ports, tokens, keys, secrets — fail closed).
    if (!ALLOWED_LITERAL_PATHS.has(path)) {
      if (!isSanitizedStable(value)) {
        throw new Error(`namingCasRepo: audit string at ${path} must be sanitized`);
      }
      if (containsSensitivePattern(value)) {
        throw new Error(
          `namingCasRepo: audit string at ${path} carries credential-shaped material`,
        );
      }
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPayloadStringsClean(item, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertPayloadStringsClean(child, path === '' ? key : `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`namingCasRepo: audit payload carries a non-serializable value at ${path}`);
}

/** Map the committed entity key to the naming target type it must bind. */
function entityTypeOf(entityKey: string): 'subscription' | 'collection' {
  if (entityKey === REDIS_KEYS.subscriptions) return 'subscription';
  if (entityKey === REDIS_KEYS.collections) return 'collection';
  throw new Error('namingCasRepo: unsupported entity key for a naming transition');
}

/**
 * Strict repository-boundary audit validation (pass-1 finding): EVERY
 * fallible audit argument is proven BEFORE the eval — absent/malformed JSON,
 * invalid/duplicate UUID, payload-vs-argument mismatch (id/ts/op/actor),
 * entity type/id + expected profile binding, NaN/Infinity/out-of-range
 * timestamps, oversized values, unknown/extra keys (the strict naming
 * projection), and credential-bearing unsanitized strings ANYWHERE in the
 * payload (recursively) are all rejected here with ZERO
 * entity/history/version/audit writes. The repository is safe independently
 * of its callers.
 */
async function validateNamingAudit(
  audit: {
    id: string;
    ts: number;
    op: string;
    actor: string;
    payloadJson: string;
  },
  binding: { entityKey: string; recordId: string; expectedProfileId: string },
): Promise<void> {
  if (!audit || typeof audit !== 'object') {
    throw new Error('namingCasRepo: audit is REQUIRED for every naming transition');
  }
  const { id, ts, op, actor, payloadJson } = audit;
  if (id === '' || payloadJson === '' || actor === '') {
    throw new Error('namingCasRepo: audit must be complete (id, actor, payload)');
  }
  if (!AUDIT_UUID_RE.test(id)) {
    throw new Error('namingCasRepo: audit id must be a canonical UUID');
  }
  if (op !== 'naming.apply' && op !== 'naming.rollback') {
    throw new Error(`namingCasRepo: unsupported audit op ${JSON.stringify(op)}`);
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0 || ts > MAX_AUDIT_SCORE) {
    throw new Error('namingCasRepo: audit ts must be a finite score in [0, MAX_SAFE_INTEGER]');
  }
  if (typeof actor !== 'string' || actor.length > MAX_AUDIT_ACTOR || !isSanitizedStable(actor)) {
    throw new Error('namingCasRepo: audit actor must be sanitized and ≤ 64 chars');
  }
  if (payloadJson.length > MAX_AUDIT_PAYLOAD_BYTES) {
    throw new Error('namingCasRepo: audit payload exceeds size bound');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error('namingCasRepo: audit payload must be valid JSON');
  }
  // THE strict specialized naming projection: unknown keys, non-naming ops,
  // unbounded strings, non-canonical ids and undoable:true all fail here.
  const event = NamingAuditEventSchema.safeParse(parsed);
  if (!event.success) {
    throw new Error('namingCasRepo: audit payload must be a strict schema-valid naming event');
  }
  // Deep per-string gate (before/after/target/profileId + ANY nested value).
  assertPayloadStringsClean(parsed, '', 0);
  // payload-vs-argument MATCH: the strict payload must agree with the args —
  // id, timestamp, op AND actor, exactly.
  if (
    event.data.id !== id ||
    event.data.ts !== ts ||
    event.data.op !== op ||
    event.data.actor !== actor
  ) {
    throw new Error('namingCasRepo: audit payload does not match the transition arguments');
  }
  // ENTITY binding: the naming target must be the entity being written.
  const entityType = entityTypeOf(binding.entityKey);
  if (event.data.target.type !== entityType) {
    throw new Error('namingCasRepo: audit target type does not match the entity key');
  }
  if (event.data.target.id !== binding.recordId) {
    throw new Error('namingCasRepo: audit target id does not match the record id');
  }
  // PROFILE binding (pass-2 finding): the strict projection REQUIRES a
  // canonical profileId and it must equal the caller's authorized expected
  // profile — every UI/assistant caller supplies and binds it.
  if (binding.expectedProfileId === undefined) {
    throw new Error('namingCasRepo: audit requires an expected profile binding');
  }
  if (event.data.profileId !== binding.expectedProfileId) {
    throw new Error('namingCasRepo: audit profile does not match the expected profile');
  }
  // REUSE check (fast path): the id must not already exist in the audit log.
  // The ATOMIC gate is the Lua HEXISTS inside the eval — this probe only
  // fails early; the race is closed by the script's pre-write check.
  const existing = await getRedis().hget<unknown>(REDIS_KEYS.audit.byId, id);
  if (existing !== null && existing !== undefined) {
    throw new Error('namingCasRepo: audit id already used');
  }
}

export async function commitEntityWithNamingHistory(options: {
  /** REDIS_KEYS.subscriptions or REDIS_KEYS.collections. */
  entityKey: string;
  recordId: string;
  /** The FULL entity record JSON (already passed through restoreRawOperators). */
  recordJson: string;
  expectedVersion: number;
  history: NamingHistoryCommit;
  /** REQUIRED durable audit event written IN the same atomic transition
   * (finding 2): no naming write may succeed without its audit event. */
  audit: {
    id: string;
    ts: number;
    op: string;
    actor: string;
    /** Serialized event payload — sanitized + bounded + schema-validated. */
    payloadJson: string;
  };
  /** REQUIRED session profile the write is bound to — the payload's
   * profileId must equal it exactly (pass-2 finding). */
  expectedProfileId: string;
  /** pass-7 blocker 4 / pass-8 blocker 6: caller profile id + expected
   * source binding (and, for collections, the gate-captured member-id list)
   * re-checked by the Lua INSIDE the atomic eval (zero-write on mismatch). */
  profileBinding: {
    profileId: string;
    type: string;
    id: string;
    /** pass-8 blocker 6: gate-captured member ids in record order. */
    memberIds?: string[];
  };
}): Promise<NamingCasResult> {
  await validateNamingAudit(options.audit, {
    entityKey: options.entityKey,
    recordId: options.recordId,
    expectedProfileId: options.expectedProfileId,
  });
  const historyOp = options.history?.op ?? '';
  const historyField = options.history?.field ?? '';
  const historyValue = options.history?.op === 'set' ? (options.history.value ?? '') : '';
  const auditOp = options.audit ? 'set' : '';
  const auditId = options.audit?.id ?? '';
  const auditTs = options.audit ? String(options.audit.ts) : '';
  const auditPayload = options.audit?.payloadJson ?? '';
  const result = (await getRedis().eval(
    CAS_ENTITY_WITH_HISTORY,
    [
      REDIS_KEYS.configVersion,
      options.entityKey,
      REDIS_KEYS.namingHistory,
      REDIS_KEYS.audit.events,
      REDIS_KEYS.audit.byId,
      REDIS_KEYS.profiles,
      REDIS_KEYS.collections,
    ],
    [
      String(options.expectedVersion),
      options.recordId,
      options.recordJson,
      historyOp,
      historyField,
      historyValue,
      auditOp,
      auditId,
      auditTs,
      auditPayload,
      options.profileBinding.profileId,
      options.profileBinding.type,
      options.profileBinding.id,
      String(options.profileBinding.memberIds?.length ?? 0),
      ...(options.profileBinding.memberIds ?? []),
    ],
  )) as [number, string];
  if (!Array.isArray(result)) {
    return { ok: false, currentVersion: null };
  }
  const [code, detail] = result;
  if (code === 1) {
    const parsedVersion = Number(detail);
    return {
      ok: true,
      currentVersion:
        Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
    };
  }
  if (code === 2) {
    return {
      ok: false,
      currentVersion: null,
      failure: detail as NamingCasResult['failure'],
    };
  }
  return {
    ok: false,
    currentVersion: Number.isSafeInteger(Number(detail)) ? Number(detail) : null,
  };
}
