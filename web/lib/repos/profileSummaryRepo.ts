import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

export const MAX_PROFILE_SUMMARY_BATCH = 8;

export interface ProfileCardSummary {
  groupsCount: number;
  rankedGroupNames: string[];
  activeRules: number;
  disabledRules: number;
  policies: Record<string, number>;
  devicesCount: number;
}

/**
 * Redis-side bounded batch projection for profile cards:
 * rule bodies and full device records never cross Upstash REST.
 * At most MAX_PROFILE_SUMMARY_BATCH (8) profiles per call so latency and
 * payload stay tightly bounded even when the workspace grows to dozens of profiles.
 */
const PROFILE_SUMMARIES_LUA = `
local function decode(raw)
  if not raw then return nil end
  local ok, val = pcall(cjson.decode, raw)
  if not ok or type(val) ~= 'table' then return nil end
  return val
end

local out = {}
for i = 1, #ARGV do
  local pid = ARGV[i]
  local base = (i - 1) * 3
  local groupsKey = KEYS[base + 1]
  local rulesKey = KEYS[base + 2]
  local devicesKey = KEYS[base + 3]

  local rawGroups = redis.call('HVALS', groupsKey)
  local groups = {}
  for _, raw in ipairs(rawGroups) do
    local g = decode(raw)
    if g and type(g.name) == 'string' then
      table.insert(groups, { name = g.name, rank = tonumber(g.rank) or 0 })
    end
  end
  table.sort(groups, function(a, b)
    if a.rank ~= b.rank then return a.rank < b.rank end
    return a.name < b.name
  end)
  local rankedGroupNames = {}
  for idx, g in ipairs(groups) do
    rankedGroupNames[idx] = g.name
  end

  local rawRules = redis.call('HVALS', rulesKey)
  local activeRules = 0
  local disabledRules = 0
  local policies = {}
  for _, raw in ipairs(rawRules) do
    local r = decode(raw)
    if r then
      if r.enabled == false then
        disabledRules = disabledRules + 1
      else
        activeRules = activeRules + 1
      end
      if type(r.policy) == 'string' and r.policy ~= '' then
        policies[r.policy] = (policies[r.policy] or 0) + 1
      end
    end
  end

  local devicesCount = redis.call('HLEN', devicesKey)

  out[pid] = {
    groupsCount = #rankedGroupNames,
    rankedGroupNames = rankedGroupNames,
    activeRules = activeRules,
    disabledRules = disabledRules,
    policies = policies,
    devicesCount = devicesCount,
  }
end

return cjson.encode(out)
`.trim();

function normalizeSummary(raw: unknown): ProfileCardSummary {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rankedGroupNames = Array.isArray(rec.rankedGroupNames)
    ? rec.rankedGroupNames.filter((name): name is string => typeof name === 'string')
    : [];
  const rawPolicies = rec.policies;
  const policies: Record<string, number> = Object.create(null);
  if (rawPolicies && typeof rawPolicies === 'object' && !Array.isArray(rawPolicies)) {
    for (const [policy, count] of Object.entries(rawPolicies as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        policies[policy] = count;
      }
    }
  }
  const activeRules = typeof rec.activeRules === 'number' && Number.isFinite(rec.activeRules) ? rec.activeRules : 0;
  const disabledRules =
    typeof rec.disabledRules === 'number' && Number.isFinite(rec.disabledRules) ? rec.disabledRules : 0;
  const devicesCount =
    typeof rec.devicesCount === 'number' && Number.isFinite(rec.devicesCount) ? rec.devicesCount : 0;
  const groupsCount =
    typeof rec.groupsCount === 'number' && Number.isFinite(rec.groupsCount)
      ? rec.groupsCount
      : rankedGroupNames.length;
  return {
    groupsCount,
    rankedGroupNames,
    activeRules,
    disabledRules,
    policies,
    devicesCount,
  };
}

export async function getProfileCardSummaries(
  profileIds: readonly string[],
): Promise<Record<string, ProfileCardSummary>> {
  const uniqueIds = [...new Set(profileIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return {};
  if (uniqueIds.length > MAX_PROFILE_SUMMARY_BATCH) {
    throw new Error(`At most ${MAX_PROFILE_SUMMARY_BATCH} profile ids may be requested per batch.`);
  }

  const keys: string[] = [];
  for (const id of uniqueIds) {
    keys.push(REDIS_KEYS.proxyGroups(id), REDIS_KEYS.rules(id), REDIS_KEYS.devices(id));
  }

  const raw = await getRedis().eval(PROFILE_SUMMARIES_LUA, keys, uniqueIds);
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};

  const result: Record<string, ProfileCardSummary> = {};
  for (const id of uniqueIds) {
    result[id] = normalizeSummary(map[id]);
  }
  return result;
}
