import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { RuleSet } from '@/schemas';

/**
 * Storage layout (since the content split):
 *   - hash `rule-sets`            field=id → meta record, `content` always ''
 *   - key  `rule-set-content:{id}` → the full content string
 *
 * The split keeps HGETALL (the render path's listRuleSets) from dragging
 * every rule-set body across the wire — rendering only needs the meta fields.
 * Legacy fields written before the split still embed `content` in the hash
 * value; readers fall back to it, but the read path never writes (migration
 * is scripts/migrate-rule-set-content.ts).
 */

/** Hash value to store: the meta record with the body stripped. */
function toMeta(set: RuleSet): RuleSet {
  return { ...set, content: '' };
}

/**
 * Meta-only listing — `content` is always '' in the returned records (legacy
 * hash values that still embed content get it stripped here, without writing
 * back). Callers that need the body must go through getRuleSet /
 * getRuleSetContent / getRuleSetByName.
 */
export async function listRuleSets(): Promise<RuleSet[]> {
  const all = await getRedis().hgetall<Record<string, RuleSet>>(REDIS_KEYS.ruleSets);
  if (!all) return [];
  return Object.values(all)
    .map(toMeta)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Full record: meta from the hash + content from its standalone key. */
export async function getRuleSet(id: string): Promise<RuleSet | null> {
  const [meta, stored] = await Promise.all([
    getRedis().hget<RuleSet>(REDIS_KEYS.ruleSets, id),
    getRedis().get<string>(REDIS_KEYS.ruleSetContent(id)),
  ]);
  if (!meta) return null;
  // Unmigrated legacy field → content key absent → use the embedded body.
  return { ...meta, content: stored ?? meta.content ?? '' };
}

/** Just the body. null = rule-set doesn't exist (an empty body returns ''). */
export async function getRuleSetContent(id: string): Promise<string | null> {
  const [meta, stored] = await Promise.all([
    getRedis().hget<RuleSet>(REDIS_KEYS.ruleSets, id),
    getRedis().get<string>(REDIS_KEYS.ruleSetContent(id)),
  ]);
  if (stored !== null) return stored;
  if (!meta) return null;
  return meta.content ?? '';
}

/**
 * Full record by name. Stays HGETALL+find — the library is small (dozens),
 * a name index isn't worth the bookkeeping; only the hit's content is fetched.
 */
export async function getRuleSetByName(name: string): Promise<RuleSet | null> {
  const all = await getRedis().hgetall<Record<string, RuleSet>>(REDIS_KEYS.ruleSets);
  if (!all) return null;
  const raw = Object.values(all).find((s) => s.name === name);
  if (!raw) return null;
  const stored = await getRedis().get<string>(REDIS_KEYS.ruleSetContent(raw.id));
  return { ...raw, content: stored ?? raw.content ?? '' };
}

// Writes bump config:version in the same multi() — rule-sets are emitted
// into the rendered config, so the render cache must be invalidated.

export async function upsertRuleSet(set: RuleSet): Promise<void> {
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.ruleSets, { [set.id]: toMeta(set) })
    .set(REDIS_KEYS.ruleSetContent(set.id), set.content ?? '')
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function deleteRuleSet(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.ruleSets, id)
    .del(REDIS_KEYS.ruleSetContent(id))
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number, number]>();
  return removed > 0;
}
