/**
 * Global config version counter.
 *
 * Every repo write that can change the rendered config output bumps this
 * (INCR) — see the per-repo write functions. The render cache
 * (lib/engine/renderCache.ts) stores the version it rendered at and treats
 * any mismatch as a miss. The bump lives at the repo layer (not the service
 * layer) on purpose: AI write primitives (lib/ai/actions/primitives/) call
 * repos directly and must invalidate the cache too.
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

/** Current version. A missing key (fresh deployment) reads as 0. */
export async function getConfigVersion(): Promise<number> {
  const value = await getRedis().get<number>(REDIS_KEYS.configVersion);
  return value ?? 0;
}

/**
 * Bump after a write. Most repos bundle the INCR into the same multi() as
 * the write itself; this standalone helper exists for write paths that
 * can't (and for tests). Must be awaited — a fire-and-forget bump that gets
 * dropped means the user saves and still sees the stale render.
 */
export async function bumpConfigVersion(): Promise<void> {
  await getRedis().incr(REDIS_KEYS.configVersion);
}
