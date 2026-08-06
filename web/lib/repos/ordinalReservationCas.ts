import { REDIS_KEYS } from '@/lib/redis/keys';
import { MAX_ORDINAL, MAX_TOTAL_ASSIGNMENTS } from '@/lib/repos/nodeOrdinalRepo';
import type { OrdinalReservationPlan } from '@/lib/services/nodeOrdinalService';

/** Fixed ARGV/KEYS projection shared by every node-pipeline CAS script. */
export function encodeOrdinalReservationPlan(plan: OrdinalReservationPlan): {
  counterKeys: string[];
  args: string[];
} {
  const assignments = plan.sources.flatMap((source, sourceIndex) =>
    source.fields.map((field) => [
      String(sourceIndex + 1),
      `${source.sourceKey}:${field.fingerprint}`,
      String(field.ordinal),
    ]),
  );
  return {
    counterKeys: plan.sources.map((source) => REDIS_KEYS.nodeOrdinalCounter(source.sourceKey)),
    args: [
      String(plan.expectedGeneration),
      String(plan.expectedGlobalSize),
      String(plan.sources.length),
      String(assignments.length),
      ...plan.sources.flatMap((source) => [
        source.sourceKey,
        source.expectedCounterRaw === null ? '1' : '0',
        source.expectedCounterRaw ?? '',
        String(source.expectedSourceSize),
        String(source.nextCounter),
      ]),
      ...assignments.flat(),
    ],
  };
}

/**
 * KEYS: version, entity hash, history hash, ordinal hash, generation,
 *       followed by one counter key per planned source.
 * ARGV: expectedVersion, entityId, entityJson, action, historyField, then
 *       encodeOrdinalReservationPlan().args.
 */
export const CAS_PIPELINE_ENTITY_WITH_ORDINALS = `
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
if not isStringKey(KEYS[1]) then return {2, 'version-wrongtype'} end
if not isHashKey(KEYS[2]) then return {2, 'entity-wrongtype'} end
if not isHashKey(KEYS[3]) then return {2, 'history-wrongtype'} end
if not isHashKey(KEYS[4]) then return {2, 'ordinal-hash-wrongtype'} end
if not isStringKey(KEYS[5]) then return {2, 'ordinal-generation-wrongtype'} end
if ARGV[4] ~= 'set' and ARGV[4] ~= 'delete' then return {2, 'entity-action-malformed'} end

local currentRaw = redis.call('GET', KEYS[1])
local current = 0
if currentRaw then
  if not isCanonicalUnsigned(currentRaw) then return {2, 'version-malformed'} end
  current = tonumber(currentRaw)
  if not current or current > 9007199254740990 then return {2, 'version-overflow'} end
end
local expected = tonumber(ARGV[1])
if not expected or current ~= expected then
  return {0, string.format('%.0f', current)}
end

local generationRaw = redis.call('GET', KEYS[5])
if not generationRaw then generationRaw = '0' end
if not isCanonicalUnsigned(generationRaw) or generationRaw ~= ARGV[6] then
  return {0, 'ordinal-generation-mismatch'}
end
local generation = tonumber(generationRaw)
if not generation or generation > 9007199254740990 then
  return {2, 'ordinal-generation-overflow'}
end
local expectedGlobalSize = tonumber(ARGV[7])
local sourceCount = tonumber(ARGV[8])
local assignmentCount = tonumber(ARGV[9])
if not expectedGlobalSize or not sourceCount or not assignmentCount then
  return {2, 'ordinal-plan-malformed'}
end
if sourceCount < 0 or assignmentCount < 0 or sourceCount > ${MAX_TOTAL_ASSIGNMENTS} or assignmentCount > ${MAX_TOTAL_ASSIGNMENTS} then
  return {2, 'ordinal-plan-bounds'}
end
if redis.call('HLEN', KEYS[4]) ~= expectedGlobalSize then
  return {0, 'ordinal-size-mismatch'}
end

local all = redis.call('HGETALL', KEYS[4])
local cursor = 10
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
  if not isStringKey(KEYS[5 + sourceIndex]) then return {2, 'ordinal-counter-wrongtype'} end
  local sourceKey = ARGV[cursor]
  local missingFlag = ARGV[cursor + 1]
  local expectedCounter = ARGV[cursor + 2]
  local expectedSourceSize = tonumber(ARGV[cursor + 3])
  local nextCounter = tonumber(ARGV[cursor + 4])
  if not sourceKey or sourceKey == '' or (missingFlag ~= '0' and missingFlag ~= '1') or
     not expectedSourceSize or expectedSourceSize < 0 or not nextCounter or
     nextCounter < 1 or nextCounter > ${MAX_ORDINAL} then
    return {2, 'ordinal-plan-malformed'}
  end
  local actualCounter = redis.call('GET', KEYS[5 + sourceIndex])
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
  local base = 0
  if actualCounter and isCanonicalUnsigned(actualCounter) then
    local parsedCounter = tonumber(actualCounter)
    if parsedCounter and parsedCounter <= 9007199254740991 and parsedCounter > base then
      base = parsedCounter
    end
  end
  bases[sourceIndex] = base
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
local fieldSources = {}
local seenFields = {}
local assignmentIndex = 1
while assignmentIndex <= assignmentCount do
  local plannedSource = tonumber(ARGV[cursor])
  local field = ARGV[cursor + 1]
  local ordinalRaw = ARGV[cursor + 2]
  local ordinal = tonumber(ordinalRaw)
  local fieldColon = field and string.find(field, ':', 1, true)
  if not plannedSource or plannedSource < 1 or plannedSource > sourceCount or
     not fieldColon or string.sub(field, 1, fieldColon - 1) ~= sources[plannedSource] or
     not isCanonicalUnsigned(ordinalRaw) or not ordinal or
     ordinal ~= bases[plannedSource] + 1 or ordinal > ${MAX_ORDINAL} then
    return {2, 'ordinal-plan-malformed'}
  end
  if seenFields[field] then
    return {2, 'ordinal-plan-duplicate'}
  end
  if redis.call('HGET', KEYS[4], field) then return {0, 'ordinal-field-exists'} end
  seenFields[field] = true
  bases[plannedSource] = ordinal
  sourceSizes[plannedSource] = sourceSizes[plannedSource] + 1
  if sourceSizes[plannedSource] > ${MAX_TOTAL_ASSIGNMENTS} or expectedGlobalSize + assignmentIndex > ${MAX_TOTAL_ASSIGNMENTS} then
    return {2, 'ordinal-plan-cap'}
  end
  fields[assignmentIndex] = field
  ordinals[assignmentIndex] = ordinalRaw
  fieldSources[assignmentIndex] = plannedSource
  cursor = cursor + 3
  assignmentIndex = assignmentIndex + 1
end
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
  redis.call('SET', KEYS[5 + sourceIndex], string.format('%.0f', nextCounters[sourceIndex]))
  sourceIndex = sourceIndex + 1
end
if assignmentCount > 0 then
  redis.call('SET', KEYS[5], string.format('%.0f', generation + 1))
end
if ARGV[4] == 'set' then
  redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
elseif ARGV[4] == 'delete' then
  redis.call('HDEL', KEYS[2], ARGV[2])
end
if ARGV[5] ~= '' then redis.call('HDEL', KEYS[3], ARGV[5]) end
redis.call('SET', KEYS[1], string.format('%.0f', nextVersion))
return {1, string.format('%.0f', nextVersion)}
`.trim();
