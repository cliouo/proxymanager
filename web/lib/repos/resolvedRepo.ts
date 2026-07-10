/**
 * Cached summary of the resolved config — what subscription nodes ended up
 * in `proxies:`, which collided, which subs fell back to stale or failed.
 *
 * `resolveConfig` rewrites this on every successful run; mutations to
 * subscriptions invalidate it explicitly. A long Redis EX acts as a safety
 * net in case an invalidation call is missed somewhere (the snapshot is
 * advisory — readers can still recompute live by calling resolveConfig).
 *
 * Per-profile (P2-5): stored as a single Redis HASH keyed by profile id, so a
 * render of profile B can't overwrite profile A's node list (which used to
 * happen with one global key — a public /api/sub poll for one profile would
 * leave the overview/AI of another profile showing the wrong nodes). Reads take
 * the profile id; invalidation clears the whole hash because a shared-resource
 * write (a subscription edit) can invalidate every profile's snapshot at once.
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

export interface ResolvedSnapshot {
  /** Profile id this snapshot was rendered for (defensive; the hash field key). */
  profileId?: string;
  /** Final node names in `proxies:`, in resolution order. */
  nodeNames: string[];
  collisions: SnapshotCollision[];
  subscriptions: SnapshotSubStatus[];
  /** Warnings carried forward, e.g. presence of the deprecated `pm-inline-collections` field. */
  warnings: string[];
  /** Anchors that had rules but no matching marker in base (renderBase 的 unmatchedAnchors)。旧快照无此字段。 */
  unmatchedAnchors?: string[];
  /** base 中实际存在的锚点注入位数量(renderBase 的 anchorsApplied.length)。旧快照无此字段。 */
  anchorsApplied?: number;
  /** ms epoch when this snapshot was computed. */
  computedAt: number;
  /** Build id of the resolved config that produced this snapshot. */
  buildId: string;
}

export async function getResolvedSnapshot(profileId: string): Promise<ResolvedSnapshot | null> {
  const value = await getRedis().hget<ResolvedSnapshot>(REDIS_KEYS.resolvedSnapshot, profileId);
  return value ?? null;
}

export async function setResolvedSnapshot(
  profileId: string,
  snapshot: ResolvedSnapshot,
): Promise<void> {
  const redis = getRedis();
  await redis.hset(REDIS_KEYS.resolvedSnapshot, { [profileId]: snapshot });
  // Whole-hash GC EX (per-field TTL isn't available on Upstash hashes).
  await redis.expire(REDIS_KEYS.resolvedSnapshot, SNAPSHOT_TTL_SECONDS);
}

export async function invalidateResolvedSnapshot(): Promise<void> {
  await getRedis().del(REDIS_KEYS.resolvedSnapshot);
}
