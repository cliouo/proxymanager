import { createHash } from 'node:crypto';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { ProblemDetailsError } from '@/lib/http/problem';
import { summarizeRules } from './ruleSummary';
import type { Rule } from '@/schemas';
import type { RuleSummary } from '@/lib/client/rule-summary';

export interface RuleQuery {
  anchor?: string | null;
  policy?: string | null;
  type?: string | null;
  enabled?: boolean;
  q?: string | null;
  sort: string;
}
export function filterAndSortRules(all: Rule[], query: RuleQuery): Rule[] {
  const [key, direction] = query.sort.split(':');
  const sign = direction === 'desc' ? -1 : 1;
  return all
    .filter((rule) => {
      if (query.anchor && rule.anchor !== query.anchor) return false;
      if (query.policy && rule.policy !== query.policy) return false;
      if (query.type && rule.type !== query.type) return false;
      if (query.enabled !== undefined && (rule.enabled !== false) !== query.enabled) return false;
      return (
        !query.q ||
        `${rule.value} ${rule.note ?? ''} ${(rule.options ?? []).join(' ')}`
          .toLowerCase()
          .includes(query.q.toLowerCase())
      );
    })
    .sort((a, b) => {
      const comparison =
        key === 'value'
          ? a.value.localeCompare(b.value)
          : key === 'added_at'
            ? a.added_at - b.added_at
            : key === 'updated_at'
              ? a.updated_at - b.updated_at
              : a.rank - b.rank;
      return sign * (comparison || a.id.localeCompare(b.id));
    });
}

/** Versioned query index. A new query/version scans once; pagination reads only IDs + page entities.
 * Arbitrary substring search has explicit scan-on-first-query semantics, not HSCAN pagination.
 */
export async function readRulePage(
  profileId: string,
  query: RuleQuery,
  offset: number,
  limit: number,
) {
  const redis = getRedis();
  const digest = createHash('sha256').update(JSON.stringify(query)).digest('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    const metaKey = `rule-page:v1:${profileId}:${digest}:meta`;
    const [rawVersion, cached] = await redis.mget<
      [number | null, { version: number; total: number; summary: RuleSummary } | null]
    >(REDIS_KEYS.configVersion, metaKey);
    const version = rawVersion ?? 0;
    const key = `rule-page:v1:${profileId}:${version}:${digest}`;
    let manifest = cached?.version === version ? cached : null;
    if (!manifest) {
      const all = await listRules(profileId);
      if ((await getConfigVersion()) !== version) continue;
      const sorted = filterAndSortRules(all, query);
      manifest = { version, total: sorted.length, summary: summarizeRules(all) };
      const tx = redis.multi();
      // Rank is the position in this stable query order, including deterministic ID ties.
      for (let start = 0; start < sorted.length; start += 500) {
        const entries = sorted
          .slice(start, start + 500)
          .map((rule, i) => ({ member: rule.id, score: start + i }));
        tx.zadd(key, entries[0], ...entries.slice(1));
      }
      if (sorted.length) tx.expire(key, 300);
      tx.set(metaKey, manifest, { ex: 240 }); // index always outlives its manifest
      await tx.exec().catch(() => undefined); // a cache outage cannot invalidate a stable read
      return {
        data: sorted.slice(offset, offset + limit),
        meta: {
          total: manifest.total,
          summary: manifest.summary,
          limit,
          offset,
          configVersion: version,
          profileId,
        },
      };
    }
    const ids = manifest.total ? await redis.zrange<string[]>(key, offset, offset + limit - 1) : [];
    const rows = ids.length
      ? await redis.hmget<Record<string, Rule>>(REDIS_KEYS.rules(profileId), ...ids)
      : null;
    if ((await getConfigVersion()) !== version) continue;
    const data = ids.map((id) => rows?.[id]).filter((rule): rule is Rule => Boolean(rule));
    // An expired/evicted index cannot turn a nonempty page into a successful empty result.
    if (data.length !== Math.min(limit, Math.max(0, manifest.total - offset))) {
      await redis.del(metaKey);
      continue;
    }
    return {
      data,
      meta: {
        total: manifest.total,
        summary: manifest.summary,
        limit,
        offset,
        configVersion: version,
        profileId,
      },
    };
  }
  throw ProblemDetailsError.preconditionFailed('规则读取期间发生变更，请重试。');
}
