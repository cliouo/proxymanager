/**
 * Fetch cache for remote subscription bodies.
 *
 * Sub-Store style — keyed by `sha256(url + ua + headers)[:16]`, persisted in
 * Redis with EX TTL so entries auto-expire. Subscriptions reuse this when
 * `noCache` isn't explicitly set and the entry is still within ttl_ms,
 * skipping the upstream HTTP request entirely.
 *
 * Optimistic-cache style (return-stale-while-refreshing) is intentionally
 * deferred — the on-render auto-refresh flow blocks on a single fetch, which
 * matches user expectations for a tool they trigger themselves.
 */

import { createHash } from 'node:crypto';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { SubscriptionTraffic } from '@/schemas';

export interface FetchCacheEntry {
  /** Stored verbatim — the Clash provider YAML we normalised on the prior fetch. */
  content: string;
  /** Sub-Userinfo parse from the previous fetch (passthrough on cache hit). */
  traffic?: SubscriptionTraffic;
  /** When the original fetch landed, ms epoch. */
  fetched_at: number;
  /** Number of proxies parsed at fetch time; surfaced in status badges. */
  proxy_count: number;
}

export interface CacheKeyParts {
  url: string;
  userAgent?: string;
  headers?: Record<string, string>;
}

export function buildCacheKey({ url, userAgent, headers }: CacheKeyParts): string {
  const headerStr = headers ? JSON.stringify(sortRecord(headers)) : '';
  const ua = userAgent ?? '';
  return createHash('sha256').update(`${url}\x00${ua}\x00${headerStr}`).digest('hex').slice(0, 16);
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(record).sort()) out[k] = record[k];
  return out;
}

export async function getFetchCache(cacheKey: string): Promise<FetchCacheEntry | null> {
  const value = await getRedis().get<FetchCacheEntry>(REDIS_KEYS.fetchCache(cacheKey));
  return value ?? null;
}

export async function setFetchCache(
  cacheKey: string,
  entry: FetchCacheEntry,
  ttlMs: number,
): Promise<void> {
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  await getRedis().set(REDIS_KEYS.fetchCache(cacheKey), entry, { ex: ttlSeconds });
}

export async function deleteFetchCache(cacheKey: string): Promise<void> {
  await getRedis().del(REDIS_KEYS.fetchCache(cacheKey));
}
