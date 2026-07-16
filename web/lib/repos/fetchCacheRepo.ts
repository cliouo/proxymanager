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
import { SubscriptionTrafficSchema, type SubscriptionTraffic } from '@/schemas';

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

/** Small tolerance for host skew; farther-future entries cannot be trusted as fresh. */
const MAX_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Parsed provider YAML is the cache payload, so parser/normaliser semantics are
 * part of the cache identity. Bump this whenever those semantics change; an
 * unversioned key is treated as epoch 1.
 */
export const FETCH_CACHE_EPOCH = 2;

export function buildCacheKey({ url, userAgent, headers }: CacheKeyParts): string {
  const headerStr = headers ? JSON.stringify(sortRecord(headers)) : '';
  const ua = userAgent ?? '';
  return createHash('sha256')
    .update(`proxy-parser-v${FETCH_CACHE_EPOCH}\x00${url}\x00${ua}\x00${headerStr}`)
    .digest('hex')
    .slice(0, 16);
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(record).sort()) out[k] = record[k];
  return out;
}

export async function getFetchCache(cacheKey: string): Promise<FetchCacheEntry | null> {
  const value = await getRedis().get<unknown>(REDIS_KEYS.fetchCache(cacheKey));
  return parseFetchCacheEntry(value);
}

function parseFetchCacheEntry(value: unknown): FetchCacheEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.content !== 'string') return null;
  if (
    typeof candidate.fetched_at !== 'number' ||
    !Number.isSafeInteger(candidate.fetched_at) ||
    candidate.fetched_at < 0 ||
    candidate.fetched_at > Date.now() + MAX_CACHE_CLOCK_SKEW_MS
  ) {
    return null;
  }
  if (
    typeof candidate.proxy_count !== 'number' ||
    !Number.isSafeInteger(candidate.proxy_count) ||
    candidate.proxy_count < 0
  ) {
    return null;
  }
  const traffic =
    candidate.traffic === undefined
      ? undefined
      : SubscriptionTrafficSchema.safeParse(candidate.traffic);
  if (traffic !== undefined && !traffic.success) return null;
  return {
    content: candidate.content,
    fetched_at: candidate.fetched_at,
    proxy_count: candidate.proxy_count,
    traffic: traffic?.data,
  };
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
