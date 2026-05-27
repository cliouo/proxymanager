/**
 * Cached summary of the resolved config — what subscription nodes ended up
 * in `proxies:`, which collided, which subs fell back to stale or failed.
 *
 * `resolveConfig` rewrites this on every successful run; mutations to
 * subscriptions invalidate it explicitly. A long Redis EX acts as a safety
 * net in case an invalidation call is missed somewhere (the snapshot is
 * advisory — readers can still recompute live by calling resolveConfig).
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

/** One-week safety-net EX. Invalidation is the primary correctness signal. */
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SnapshotCollision {
  /** Final node name involved in the collision. */
  name: string;
  /** Subscription name whose node was kept. `null` = the literal base.yaml entry was kept (sub node dropped). */
  keptFrom: string | null;
  /** Names of subscriptions whose nodes were dropped. */
  droppedFrom: string[];
}

export interface SnapshotSubStatus {
  /** Subscription name. */
  name: string;
  /** How many nodes from this sub made it into the final proxies (post-dedup). */
  injectedCount: number;
  /** True when the sub fell back to a stale cache entry on this resolve. */
  stale?: boolean;
  /** When `stale`, the upstream fetch error message. */
  staleReason?: string;
  /** Sub fetch failed entirely with no cache to fall back on. */
  error?: string;
}

export interface SnapshotPoolStatus {
  /** Collection name = emitted proxy-group name. */
  name: string;
  /** proxy-group type (only `select` in MVP). */
  type: string;
  /** Number of node names that ended up in the group's `proxies:` list. */
  memberCount: number;
  /** When set, the pool wasn't emitted; reason explains why. */
  skipped?: boolean;
  /** Human-readable skip / warning reason. */
  reason?: string;
}

export interface ResolvedSnapshot {
  /** Final node names in `proxies:`, in resolution order. */
  nodeNames: string[];
  collisions: SnapshotCollision[];
  subscriptions: SnapshotSubStatus[];
  /** Per-collection pool-group injection status. */
  pools: SnapshotPoolStatus[];
  /** Warnings carried forward, e.g. presence of the deprecated `pm-inline-collections` field. */
  warnings: string[];
  /** ms epoch when this snapshot was computed. */
  computedAt: number;
  /** Build id of the resolved config that produced this snapshot. */
  buildId: string;
}

export async function getResolvedSnapshot(): Promise<ResolvedSnapshot | null> {
  const value = await getRedis().get<ResolvedSnapshot>(REDIS_KEYS.resolvedSnapshot);
  return value ?? null;
}

export async function setResolvedSnapshot(snapshot: ResolvedSnapshot): Promise<void> {
  await getRedis().set(REDIS_KEYS.resolvedSnapshot, snapshot, { ex: SNAPSHOT_TTL_SECONDS });
}

export async function invalidateResolvedSnapshot(): Promise<void> {
  await getRedis().del(REDIS_KEYS.resolvedSnapshot);
}
