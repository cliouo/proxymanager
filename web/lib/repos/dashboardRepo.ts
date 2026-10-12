import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

/** A Redis-side projection: large bodies and rule entities never cross REST. */
export async function getDashboardSummary(profileId: string) {
  const raw = await getRedis().eval(
    `
local function decode(raw) if not raw then return nil end return cjson.decode(raw) end
local base = decode(redis.call('GET', KEYS[1]))
local counts = { anchors = 0, subscriptions = redis.call('HLEN', KEYS[3]), ruleSets = redis.call('HLEN', KEYS[4]), proxyGroups = redis.call('HLEN', KEYS[5]), rules = redis.call('HLEN', KEYS[6]) }
if base and base.anchors then counts.anchors = #base.anchors end
local groups = redis.call('HVALS', KEYS[5])
local breakdown = {}
local chainCount = 0
for _, raw in ipairs(groups) do
  local group = decode(raw)
  local kind = group.type or 'select'
  breakdown[kind] = (breakdown[kind] or 0) + 1
  if group['dialer-proxy'] then chainCount = chainCount + 1 end
end
local devices = redis.call('HVALS', KEYS[7])
local tailscale = 0
for _, raw in ipairs(devices) do
  local device = decode(raw)
  if device.features and device.features.tailscale then tailscale = tailscale + 1 end
end
local subscriptions = {}
for _, raw in ipairs(redis.call('HVALS', KEYS[3])) do
  local sub = decode(raw)
  -- The health projection is deliberately joined in the service using fingerprint validation.
  table.insert(subscriptions, { id = sub.id, name = sub.name, kind = sub.kind or 'remote', enabled = sub.enabled, display_name = sub.display_name, url = sub.url, ua_override = sub.ua_override, custom_headers = sub.custom_headers, ttl_ms = sub.ttl_ms, refresh_mode = sub.refresh_mode, fetch_failure_policy = sub.fetch_failure_policy, fetch_identity_revision = sub.fetch_identity_revision })
end
local snapshot = decode(redis.call('HGET', KEYS[8], ARGV[1]))
if snapshot then snapshot.nodeNames = nil; snapshot.collisions = nil end
local events = {}
for _, id in ipairs(redis.call('ZREVRANGE', KEYS[9], 0, 4)) do
  local event = decode(redis.call('HGET', KEYS[10], id))
  if event then table.insert(events, { id = event.id, ts = event.ts, op = event.op, actor = event.actor, undoes = event.undoes }) end
end
return cjson.encode({ counts = counts, groupTypeBreakdown = breakdown, chainCount = chainCount, deviceCounts = { total = #devices, tailscale = tailscale }, subscriptions = subscriptions, lastRenderSummary = snapshot, recentEventSummaries = events, hasBase = base ~= nil and redis.call('EXISTS', KEYS[2]) == 1, buildId = base and base.etag })
`,
    [
      REDIS_KEYS.base.meta(profileId),
      REDIS_KEYS.base.content(profileId),
      REDIS_KEYS.subscriptions,
      REDIS_KEYS.ruleSets,
      REDIS_KEYS.proxyGroups(profileId),
      REDIS_KEYS.rules(profileId),
      REDIS_KEYS.devices(profileId),
      REDIS_KEYS.resolvedSnapshot,
      REDIS_KEYS.audit.events,
      REDIS_KEYS.audit.byId,
    ],
    [profileId],
  );
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
