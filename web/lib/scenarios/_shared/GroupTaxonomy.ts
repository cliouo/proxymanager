import { afterConfigCommit } from '@/lib/repos/auditedMutation';
/**
 * TaxonomyStore — project-defined metadata for proxy-groups.
 *
 * Lives in Redis Hash `taxonomy:groups:{profileId}`, keyed by group name.
 * Per-profile (Phase 2): proxy-groups are owned per profile and names can
 * collide across profiles. Storage is orthogonal to base.yaml: renaming a
 * group via a scenario op should cascade here, but Clash never reads this data.
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { GroupTag, TaxonomyStore } from './types';

export function createTaxonomyStore(profileId: string): TaxonomyStore {
  const redis = getRedis();
  const key = REDIS_KEYS.taxonomy.groups(profileId);
  return {
    async all(): Promise<Record<string, GroupTag>> {
      const raw = await redis.hgetall<Record<string, GroupTag>>(key);
      return raw ?? {};
    },
    async get(name: string): Promise<GroupTag | null> {
      const value = await redis.hget<GroupTag>(key, name);
      return value ?? null;
    },
    async set(name: string, tag: GroupTag): Promise<void> {
      await afterConfigCommit(() => redis.hset(key, { [name]: tag }));
    },
    async delete(name: string): Promise<boolean> {
      await afterConfigCommit(() => redis.hdel(key, name));
      return true;
    },
  };
}
