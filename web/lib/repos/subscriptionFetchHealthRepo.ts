/**
 * Separate, advisory runtime fetch health for remote subscriptions (P-FFP
 * v1). Health NEVER lives in the definition row: it is a per-source Redis
 * value that expires seven days after the last actual attempt and never
 * touches config:version, render caches, snapshots, or ordinal state.
 *
 *   - `definition_fingerprint` is a base64url SHA-256 over the fetch identity
 *     (id, kind, URL, effective UA, sorted custom headers, ttl_ms, policy).
 *     API views join health ONLY when the fingerprint matches the current
 *     definition, so stale-definition health can never display.
 *   - Concurrent writes use one Lua compare-and-set: only a lexicographically
 *     newer (attempted_at, observed_at) wins — a slower older attempt cannot
 *     overwrite a newer-started one. Malformed stored values read absent and
 *     are replaceable.
 *   - Every write is best-effort: health failure never masks serving outcome.
 */

import { createHash } from 'node:crypto';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { safeJsonStringify } from '@/lib/security/safeJson';
import {
  SubscriptionFetchHealthSchema,
  effectiveFetchFailurePolicy,
  subscriptionUserAgent,
  type Subscription,
  type SubscriptionFetchHealth,
} from '@/schemas';

/** Health expires seven days after the last actual attempt. */
export const HEALTH_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Lua CAS for the per-source health key (v2 I13). An existing value is
 * timestamp-orderable ONLY when it is EXACTLY equivalent to the strict
 * SubscriptionFetchHealthSchema union: cjson decode succeeds, the
 * definition_fingerprint is the I12 canonical unpadded base64url SHA-256
 * (43 chars from [A-Za-z0-9_-], zero padding bits in the final character —
 * the canonical re-encoding's last char is one of AEIMQUYcgkosw048),
 * timestamps are SAFE nonnegative integers, the state-specific required and
 * FORBIDDEN fields hold (fresh forbids failure fields; stale-served requires
 * category/served/cached proxy_count; failed-no-cache forbids fresh_at,
 * proxy_count and traffic), traffic has the exact SubscriptionTraffic shape,
 * and the record contains ONLY the known keys of its state (exact
 * known-key rejection, mirroring the .strict() union variants). ANY
 * schema-invalid existing value — including one with newer-looking
 * timestamps — is replaced by the next valid record. Valid records keep the
 * lexicographic (attempted_at, observed_at) ordering and the write always
 * sets EX 604800.
 *
 * The validation branch uses plain Lua 5.1 constructs (pcall, cjson,
 * math.floor, next-based key enumeration) that the repo Lua test VM parses
 * but does not execute — the runnable harness cases are the first-write and
 * key-isolation paths, while the full validation semantics are pinned in
 * luaScriptSemantics and mirrored by the JS fake in
 * subscriptionFetchHealthRepo.test.ts.
 */
export const CAS_SUBSCRIPTION_FETCH_HEALTH = `
local existing = redis.call('GET', KEYS[1])
if existing then
  -- cjson by default decodes NaN/Infinity/hex number tokens that Zod's
  -- JSON read path treats as malformed. decode_invalid_numbers(false) makes
  -- decode FAIL on them (pcall catches it → the record is replaced). The
  -- config helper RETURNS the value after applying, so read the process-global
  -- setting first with no argument, then set strict mode, then restore.
  local priorInvalidNumbers = cjson.decode_invalid_numbers()
  cjson.decode_invalid_numbers(false)
  local ok, decoded = pcall(cjson.decode, existing)
  cjson.decode_invalid_numbers(priorInvalidNumbers)
  if ok and type(decoded) == 'table' then
    local fp = decoded['definition_fingerprint']
    local state = decoded['state']
    local attemptedAt = decoded['attempted_at']
    local observedAt = decoded['observed_at']
    local freshAt = decoded['fresh_at']
    local proxyCount = decoded['proxy_count']
    local category = decoded['failure_category']
    local disposition = decoded['cache_disposition']
    local traffic = decoded['traffic']
    -- Zod 4 z.number().int() is SAFE-INTEGER-bounded (within
    -- +/-9007199254740991): a plain floor check is not enough.
    local function isSafeInt(x, lower)
      if type(x) ~= 'number' then return false end
      if lower ~= nil and x < lower then return false end
      return x == math.floor(x) and x <= 9007199254740991
    end
    local canonicalFp = type(fp) == 'string'
      and string.len(fp) == 43
      and string.match(fp, '^[%w_%-]+$') ~= nil
      and string.match(fp, '[AEIMQUYcgkosw048]$') ~= nil
    local validCategory = category == 'network' or category == 'timeout'
      or category == 'http' or category == 'response-encoding'
      or category == 'response-content-format' or category == 'proxy-node'
    -- cjson decodes Infinity; Zod z.number() rejects non-finite values, so
    -- every traffic counter must be FINITE (NaN already fails >= 0; the
    -- explicit less-than-math.huge bound rejects positive Infinity while
    -- accepting every finite IEEE-754 double, exactly like Zod).
    local validTraffic = traffic == nil or (
      type(traffic) == 'table'
      and type(traffic['upload']) == 'number' and traffic['upload'] >= 0
      and traffic['upload'] < math.huge
      and type(traffic['download']) == 'number' and traffic['download'] >= 0
      and traffic['download'] < math.huge
      and type(traffic['total']) == 'number' and traffic['total'] >= 0
      and traffic['total'] < math.huge
      and isSafeInt(traffic['expire'], -9007199254740991)
    )
    local allowedKeys = {}
    local validState = false
    if state == 'fresh' then
      allowedKeys['definition_fingerprint'] = true
      allowedKeys['state'] = true
      allowedKeys['attempted_at'] = true
      allowedKeys['observed_at'] = true
      allowedKeys['fresh_at'] = true
      allowedKeys['proxy_count'] = true
      allowedKeys['traffic'] = true
      validState = isSafeInt(freshAt, 0) and isSafeInt(proxyCount, 0)
        and category == nil and disposition == nil
    elseif state == 'stale-served' then
      allowedKeys['definition_fingerprint'] = true
      allowedKeys['state'] = true
      allowedKeys['attempted_at'] = true
      allowedKeys['observed_at'] = true
      allowedKeys['fresh_at'] = true
      allowedKeys['proxy_count'] = true
      allowedKeys['traffic'] = true
      allowedKeys['failure_category'] = true
      allowedKeys['cache_disposition'] = true
      validState = isSafeInt(freshAt, 0) and isSafeInt(proxyCount, 0)
        and validCategory and disposition == 'served'
    elseif state == 'failed-no-cache' then
      allowedKeys['definition_fingerprint'] = true
      allowedKeys['state'] = true
      allowedKeys['attempted_at'] = true
      allowedKeys['observed_at'] = true
      allowedKeys['failure_category'] = true
      allowedKeys['cache_disposition'] = true
      validState = validCategory
        and (disposition == 'unavailable' or disposition == 'invalid'
          or disposition == 'policy-blocked' or disposition == 'bypassed')
        and freshAt == nil and proxyCount == nil and traffic == nil
    end
    local knownKeysOnly = true
    local key = nil
    key = next(decoded, key)
    while key ~= nil do
      if not allowedKeys[key] then
        knownKeysOnly = false
      end
      key = next(decoded, key)
    end
    if isSafeInt(attemptedAt, 0) and isSafeInt(observedAt, 0)
      and canonicalFp and validTraffic and validState and knownKeysOnly then
      local newAttempted = tonumber(ARGV[2])
      local newObserved = tonumber(ARGV[3])
      if newAttempted < attemptedAt then return 0 end
      if newAttempted == attemptedAt and newObserved <= observedAt then return 0 end
    end
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
return 1
`.trim();

/**
 * Content-addressed identity of the definition an attempt was made against.
 * Hashes without logging id, kind, URL, effective UA, sorted custom headers,
 * ttl_ms or policy: the input is hashed, never emitted.
 */
export function computeSubscriptionDefinitionFingerprint(subscription: Subscription): string {
  const customHeaders = subscription.custom_headers
    ? Object.fromEntries(
        Object.entries(subscription.custom_headers).sort(([a], [b]) => a.localeCompare(b)),
      )
    : undefined;
  const definition = {
    id: subscription.id,
    kind: subscription.kind,
    url: subscription.kind === 'remote' ? subscription.url : undefined,
    userAgent: subscriptionUserAgent(subscription),
    custom_headers: customHeaders,
    ttl_ms: subscription.ttl_ms,
    ...(subscription.kind === 'remote'
      ? { policy: effectiveFetchFailurePolicy(subscription) }
      : {}),
  };
  return createHash('sha256').update(safeJsonStringify(definition)).digest('base64url');
}

/** Whether a stored health value belongs to the CURRENT definition. */
export function healthMatchesDefinition(
  subscription: Subscription,
  health: SubscriptionFetchHealth | null | undefined,
): boolean {
  return (
    health !== null &&
    health !== undefined &&
    health.definition_fingerprint === computeSubscriptionDefinitionFingerprint(subscription)
  );
}

function parseFetchHealth(value: unknown): SubscriptionFetchHealth | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = SubscriptionFetchHealthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Best-effort write of one actual-attempt health record (v2 I13). EVERY
 * outgoing record is validated against SubscriptionFetchHealthSchema BEFORE
 * any Redis eval; a schema-invalid record is a best-effort NO-OP (never a
 * raw eval). CAS-drop (older attempt) and infrastructure errors are also
 * swallowed: recording health must never turn a successful serve into a
 * failure.
 */
export async function recordSubscriptionFetchHealth(
  subscription: Subscription,
  health: SubscriptionFetchHealth,
): Promise<void> {
  try {
    const parsed = SubscriptionFetchHealthSchema.safeParse(health);
    if (!parsed.success) return;
    await getRedis().eval(
      CAS_SUBSCRIPTION_FETCH_HEALTH,
      [REDIS_KEYS.subscriptionFetchHealth(subscription.id)],
      [
        safeJsonStringify(parsed.data),
        String(parsed.data.attempted_at),
        String(parsed.data.observed_at),
        String(HEALTH_TTL_SECONDS),
      ],
    );
  } catch {
    // best-effort by contract — a health hiccup never masks serving outcome
  }
}

export async function getSubscriptionFetchHealth(
  id: string,
): Promise<SubscriptionFetchHealth | null> {
  const value = await getRedis().get<unknown>(REDIS_KEYS.subscriptionFetchHealth(id));
  return parseFetchHealth(value);
}

export async function getSubscriptionFetchHealthMany(
  ids: readonly string[],
): Promise<Array<SubscriptionFetchHealth | null>> {
  if (ids.length === 0) return [];
  const values = await getRedis().mget<unknown[]>(
    ...ids.map((id) => REDIS_KEYS.subscriptionFetchHealth(id)),
  );
  return values.map(parseFetchHealth);
}

/** Best-effort cleanup after a successful definition CAS delete. */
export async function deleteSubscriptionFetchHealth(id: string): Promise<void> {
  try {
    await getRedis().del(REDIS_KEYS.subscriptionFetchHealth(id));
  } catch {
    // best-effort by contract
  }
}
