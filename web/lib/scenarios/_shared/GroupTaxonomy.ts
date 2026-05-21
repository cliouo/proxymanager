/**
 * TaxonomyStore — project-defined metadata for proxy-groups.
 *
 * Lives in Redis Hash `taxonomy:groups`, keyed by group name. Storage is
 * orthogonal to base.yaml: renaming a group via a scenario op should
 * cascade here, but Clash itself never reads this data.
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { GroupTag, TaxonomyStore } from './types';

export function createTaxonomyStore(): TaxonomyStore {
  const redis = getRedis();
  return {
    async all(): Promise<Record<string, GroupTag>> {
      const raw = await redis.hgetall<Record<string, GroupTag>>(REDIS_KEYS.taxonomy.groups);
      return raw ?? {};
    },
    async get(name: string): Promise<GroupTag | null> {
      const value = await redis.hget<GroupTag>(REDIS_KEYS.taxonomy.groups, name);
      return value ?? null;
    },
    async set(name: string, tag: GroupTag): Promise<void> {
      await redis.hset(REDIS_KEYS.taxonomy.groups, { [name]: tag });
    },
    async delete(name: string): Promise<boolean> {
      const removed = await redis.hdel(REDIS_KEYS.taxonomy.groups, name);
      return removed > 0;
    },
  };
}
