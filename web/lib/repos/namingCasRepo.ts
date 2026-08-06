/**
 * Atomic naming apply/rollback commit — ONE Redis CAS transaction.
 *
 * The config record, config:version, naming-history, durable audit and sealed
 * ordinal reservations move in a SINGLE eval (C8/C14): all change or none do. Redis does NOT
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
import { encodeOrdinalReservationPlan } from '@/lib/repos/ordinalReservationCas';
import { MAX_ORDINAL, MAX_TOTAL_ASSIGNMENTS } from '@/lib/repos/nodeOrdinalRepo';
import { NamingHistoryPlanSchema } from '@/lib/repos/namingHistoryRepo';
import { containsSensitivePattern, redactSensitiveText } from '@/lib/proxies/namingSanitize';
import type { OrdinalReservationPlan } from '@/lib/services/nodeOrdinalService';
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
 *       [6] profiles hash, [7] collections hash, [8] ordinal generation,
 *       [9] ordinal hash, [10..] one counter key per planned source.
 * ARGV: [1] expected version, [2] record id, [3] record JSON,
 *       [4] history op ('' | 'set' | 'del'), [5] history field, [6] history value,
 *       [7] audit op ('' | 'set'), [8] audit event id, [9] audit ts (score),
 *       [10] audit event JSON, [11] caller profile id (empty for global),
 *       [12] authority/source type (`global` | `none` | `subscription` |
 *       `collection`), [13] expected
 *       source id ('' when type is 'none'), [14] expected collection member
 *       COUNT, [15] expected ordinal generation, [16] audit cap,
 *       [17..16+n] the gate-captured member ids in record order, followed by
 *       encodeOrdinalReservationPlan().args. pass-8 blocker 6:
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
if not isStringKey(KEYS[8]) then return {2, 'ordinal-generation-wrongtype'} end
if not isHashKey(KEYS[9]) then return {2, 'ordinal-hash-wrongtype'} end
if ARGV[4] ~= 'set' and ARGV[4] ~= 'del' then return {2, 'history-op-invalid'} end
if ARGV[5] == '' then return {2, 'history-field-invalid'} end
if ARGV[4] == 'set' and ARGV[6] == '' then return {2, 'history-value-invalid'} end
-- Profile-scoped assistant writes revalidate the caller profile's CURRENT
-- source binding inside this eval. The authenticated web workspace uses the
-- explicit global authority type instead; its complete consumer set and every
-- profile mutation remain protected by the same config-version CAS.
if ARGV[12] ~= 'global' then
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
    if col.subscription_ids[i] ~= ARGV[16 + i] then
      return {2, 'profile-binding-mismatch'}
    end
  end
end
end
local ordinalRaw = redis.call('GET', KEYS[8])
if not ordinalRaw then ordinalRaw = '0' end
if not isCanonicalUnsigned(ordinalRaw) or ordinalRaw ~= ARGV[15] then
  return {0, 'ordinal-generation-mismatch'}
end
local auditCap = tonumber(ARGV[16])
if not auditCap or auditCap < 1 or auditCap > 100000 then
  return {2, 'audit-cap-invalid'}
end
local auditEvicted = {}
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
  -- Reuse check IN the same atomic eval: both audit indexes must be clear.
  -- Checking only by-id permits a zset-only orphan to be overwritten, while
  -- checking only the zset permits a payload-only orphan to be overwritten.
  if redis.call('HEXISTS', KEYS[5], ARGV[8]) == 1 or
     redis.call('ZSCORE', KEYS[4], ARGV[8]) then
    return {2, 'audit-id-exists'}
  end
  -- Select existing victims BEFORE inserting the new event. A legitimate
  -- late-arriving event may have an older score than the whole retained log;
  -- post-insert rank trimming would immediately delete that just-committed
  -- event and leave a naming transition without durable audit evidence.
  local auditCard = redis.call('ZCARD', KEYS[4])
  local auditOverflow = auditCard - auditCap + 1
  if auditOverflow > 0 then
    auditEvicted = redis.call('ZRANGE', KEYS[4], 0, auditOverflow - 1)
  end
end
-- The sealed ordinal reservation follows the positional collection members.
-- It is validated completely before entity/history/audit/ordinal mutations.
local ordinalCursor = 17 + tonumber(ARGV[14])
if ARGV[ordinalCursor] ~= ARGV[15] then return {2, 'ordinal-plan-generation'} end
local expectedGlobalSize = tonumber(ARGV[ordinalCursor + 1])
local sourceCount = tonumber(ARGV[ordinalCursor + 2])
local assignmentCount = tonumber(ARGV[ordinalCursor + 3])
if not expectedGlobalSize or not sourceCount or not assignmentCount or
   sourceCount < 0 or assignmentCount < 0 or sourceCount > ${MAX_TOTAL_ASSIGNMENTS} or
   assignmentCount > ${MAX_TOTAL_ASSIGNMENTS} then
  return {2, 'ordinal-plan-bounds'}
end
if redis.call('HLEN', KEYS[9]) ~= expectedGlobalSize then
  return {0, 'ordinal-size-mismatch'}
end
local generation = tonumber(ordinalRaw)
if not generation or generation > 9007199254740990 then
  return {2, 'ordinal-generation-overflow'}
end
local allOrdinals = redis.call('HGETALL', KEYS[9])
local planCursor = ordinalCursor + 4
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
  if not isStringKey(KEYS[9 + sourceIndex]) then return {2, 'ordinal-counter-wrongtype'} end
  local sourceKey = ARGV[planCursor]
  local missingFlag = ARGV[planCursor + 1]
  local expectedCounter = ARGV[planCursor + 2]
  local expectedSourceSize = tonumber(ARGV[planCursor + 3])
  local nextCounter = tonumber(ARGV[planCursor + 4])
  if not sourceKey or sourceKey == '' or (missingFlag ~= '0' and missingFlag ~= '1') or
     not expectedSourceSize or expectedSourceSize < 0 or not nextCounter or
     nextCounter < 1 or nextCounter > ${MAX_ORDINAL} then
    return {2, 'ordinal-plan-malformed'}
  end
  local actualCounter = redis.call('GET', KEYS[9 + sourceIndex])
  if missingFlag == '1' then
    if actualCounter then return {0, 'ordinal-counter-mismatch'} end
  elseif not actualCounter or actualCounter ~= expectedCounter then
    return {0, 'ordinal-counter-mismatch'}
  end
  if sourceLookup[sourceKey] then return {2, 'ordinal-source-duplicate'} end
  local base = 0
  if actualCounter and isCanonicalUnsigned(actualCounter) then
    local parsedCounter = tonumber(actualCounter)
    if parsedCounter and parsedCounter <= 9007199254740991 and parsedCounter > base then
      base = parsedCounter
    end
  end
  sources[sourceIndex] = sourceKey
  sourceLookup[sourceKey] = sourceIndex
  sourceSizes[sourceIndex] = 0
  expectedSourceSizes[sourceIndex] = expectedSourceSize
  maxExistingBySource[sourceIndex] = 0
  seenExistingBySource[sourceIndex] = {}
  bases[sourceIndex] = base
  nextCounters[sourceIndex] = nextCounter
  planCursor = planCursor + 5
  sourceIndex = sourceIndex + 1
end
local pairIndex = 1
while pairIndex <= #allOrdinals do
  local field = allOrdinals[pairIndex]
  local colon = string.find(field, ':', 1, true)
  if colon then
    local storedSource = string.sub(field, 1, colon - 1)
    local storedSourceIndex = sourceLookup[storedSource]
    if storedSourceIndex then
      sourceSizes[storedSourceIndex] = sourceSizes[storedSourceIndex] + 1
      local stored = allOrdinals[pairIndex + 1]
      if isCanonicalUnsigned(stored) then
        local storedNumber = tonumber(stored)
        if storedNumber and storedNumber >= 1 and storedNumber <= ${MAX_ORDINAL} then
          if seenExistingBySource[storedSourceIndex][stored] then
            return {2, 'ordinal-existing-duplicate'}
          end
          seenExistingBySource[storedSourceIndex][stored] = true
          if storedNumber > maxExistingBySource[storedSourceIndex] then
            maxExistingBySource[storedSourceIndex] = storedNumber
          end
        end
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
  local plannedSource = tonumber(ARGV[planCursor])
  local field = ARGV[planCursor + 1]
  local plannedOrdinalRaw = ARGV[planCursor + 2]
  local plannedOrdinal = tonumber(plannedOrdinalRaw)
  local fieldColon = field and string.find(field, ':', 1, true)
  if not plannedSource or plannedSource < 1 or plannedSource > sourceCount or
     not fieldColon or string.sub(field, 1, fieldColon - 1) ~= sources[plannedSource] or
     not isCanonicalUnsigned(plannedOrdinalRaw) or not plannedOrdinal or
     plannedOrdinal ~= bases[plannedSource] + 1 or plannedOrdinal > ${MAX_ORDINAL} then
    return {2, 'ordinal-plan-nonmonotonic'}
  end
  if seenFields[field] or redis.call('HGET', KEYS[9], field) then
    return {0, 'ordinal-field-exists'}
  end
  seenFields[field] = true
  bases[plannedSource] = plannedOrdinal
  sourceSizes[plannedSource] = sourceSizes[plannedSource] + 1
  if sourceSizes[plannedSource] > ${MAX_TOTAL_ASSIGNMENTS} or
     expectedGlobalSize + assignmentIndex > ${MAX_TOTAL_ASSIGNMENTS} then
    return {2, 'ordinal-plan-cap'}
  end
  fields[assignmentIndex] = field
  ordinals[assignmentIndex] = plannedOrdinalRaw
  planCursor = planCursor + 3
  assignmentIndex = assignmentIndex + 1
end
sourceIndex = 1
while sourceIndex <= sourceCount do
  if bases[sourceIndex] ~= nextCounters[sourceIndex] then
    return {2, 'ordinal-counter-rollback'}
  end
  sourceIndex = sourceIndex + 1
end
local currentRaw = redis.call('GET', KEYS[1])
local current = 0
if currentRaw then
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
assignmentIndex = 1
while assignmentIndex <= assignmentCount do
  redis.call('HSET', KEYS[9], fields[assignmentIndex], ordinals[assignmentIndex])
  assignmentIndex = assignmentIndex + 1
end
sourceIndex = 1
while sourceIndex <= sourceCount do
  redis.call('SET', KEYS[9 + sourceIndex], string.format('%.0f', nextCounters[sourceIndex]))
  sourceIndex = sourceIndex + 1
end
if assignmentCount > 0 then
  redis.call('SET', KEYS[8], string.format('%.0f', generation + 1))
end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
if ARGV[4] == 'set' then
  redis.call('HSET', KEYS[3], ARGV[5], ARGV[6])
elseif ARGV[4] == 'del' then
  redis.call('HDEL', KEYS[3], ARGV[5])
end
if ARGV[7] == 'set' then
  if #auditEvicted > 0 then
    redis.call('ZREMRANGEBYRANK', KEYS[4], 0, #auditEvicted - 1)
    for i = 1, #auditEvicted do redis.call('HDEL', KEYS[5], auditEvicted[i]) end
  end
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
  'scope',
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

const MAX_NAMING_HISTORY_BYTES = 64 * 1024;

/** Bind the undo receipt to this exact entity before any Redis call. */
function validateNamingHistory(
  history: NamingHistoryCommit,
  binding: { entityKey: string; recordId: string },
): void {
  if (!history || typeof history !== 'object') {
    throw new Error('namingCasRepo: naming history is REQUIRED');
  }
  if (history.op !== 'set' && history.op !== 'del') {
    throw new Error('namingCasRepo: unsupported naming history operation');
  }
  const expectedField = `${entityTypeOf(binding.entityKey)}:${binding.recordId}`;
  if (history.field !== expectedField) {
    throw new Error('namingCasRepo: naming history target does not match the entity');
  }
  if (history.op === 'del') {
    if (history.value !== undefined) {
      throw new Error('namingCasRepo: naming history delete must not carry a value');
    }
    return;
  }
  if (
    typeof history.value !== 'string' ||
    history.value === '' ||
    history.value.length > MAX_NAMING_HISTORY_BYTES
  ) {
    throw new Error('namingCasRepo: naming history value is missing or exceeds the size bound');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(history.value);
  } catch {
    throw new Error('namingCasRepo: naming history value must be valid JSON');
  }
  if (!NamingHistoryPlanSchema.safeParse(parsed).success) {
    throw new Error('namingCasRepo: naming history value must be a valid prior plan');
  }
}

/**
 * Strict repository-boundary audit validation (pass-1 finding): EVERY
 * fallible audit argument is proven BEFORE the eval — absent/malformed JSON,
 * invalid/duplicate UUID, payload-vs-argument mismatch (id/ts/op/actor),
 * entity type/id + expected global/profile authority, NaN/Infinity/out-of-range
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
  binding: { entityKey: string; recordId: string; expectedProfileId?: string },
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
  // Authority binding: assistant events bind a concrete profile; global web
  // workspace events explicitly carry scope=global and no profileId.
  if (binding.expectedProfileId === undefined) {
    if (event.data.scope !== 'global' || event.data.profileId !== undefined) {
      throw new Error('namingCasRepo: audit does not match global authority');
    }
  } else if (event.data.scope === 'global' || event.data.profileId !== binding.expectedProfileId) {
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
  ordinalPlan: OrdinalReservationPlan;
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
  /** Profile-scoped authority id; absent only for an explicit global write. */
  expectedProfileId?: string;
  /** Profile authority binding rechecked by Lua, or the explicit global
   * marker protected by the shared config-version CAS. */
  profileBinding: {
    profileId: string;
    type: string;
    id: string;
    /** pass-8 blocker 6: gate-captured member ids in record order. */
    memberIds?: string[];
  };
}): Promise<NamingCasResult> {
  validateNamingHistory(options.history, {
    entityKey: options.entityKey,
    recordId: options.recordId,
  });
  if (!options.audit || typeof options.audit !== 'object') {
    throw new Error('namingCasRepo: audit is REQUIRED for every naming transition');
  }
  if (options.expectedProfileId === undefined) {
    if (options.profileBinding.type !== 'global' || options.profileBinding.profileId !== '') {
      throw new Error('namingCasRepo: global authority binding is malformed');
    }
  } else if (options.expectedProfileId !== options.profileBinding.profileId) {
    throw new Error('namingCasRepo: expected profile and live binding profile must match');
  }
  await validateNamingAudit(options.audit, {
    entityKey: options.entityKey,
    recordId: options.recordId,
    expectedProfileId: options.expectedProfileId,
  });
  const historyOp = options.history.op;
  const historyField = options.history.field;
  const historyValue = options.history.op === 'set' ? options.history.value! : '';
  const auditOp = options.audit ? 'set' : '';
  const auditId = options.audit?.id ?? '';
  const auditTs = options.audit ? String(options.audit.ts) : '';
  const auditPayload = options.audit?.payloadJson ?? '';
  const encodedOrdinals = encodeOrdinalReservationPlan(options.ordinalPlan);
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
      REDIS_KEYS.nodeOrdinalGeneration,
      REDIS_KEYS.nodeOrdinals,
      ...encodedOrdinals.counterKeys,
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
      String(options.ordinalPlan.expectedGeneration),
      '1000',
      ...(options.profileBinding.memberIds ?? []),
      ...encodedOrdinals.args,
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
