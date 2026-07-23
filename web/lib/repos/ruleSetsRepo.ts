import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Rule, RuleSet } from '@/schemas';

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

/**
 * Atomically compare config:version, apply one rule-set write-or-delete plus any
 * rename-cascaded rule writes, and bump the generation exactly once.
 *
 * Rule-sets are a SHARED library: a behavior/url/name change alters the rendered
 * config of every profile that references it (and, transitively, every device of
 * those profiles). The commit therefore has to land under the same generation the
 * preflight validated — otherwise a concurrent shared-layer write could turn the
 * checked candidate into a state nobody validated.
 *
 * The cascaded rule writes ride along in the same script because a rename that
 * updated the library but not the referencing rules would leave every one of
 * those profiles pointing at a name that no longer exists — mihomo aborts the
 * whole config with `not found rule-set`.
 */
const CAS_RULE_SET_CHANGE = `
local currentRaw = redis.call('GET', KEYS[1])
local current = tonumber(currentRaw or '0')
local expected = tonumber(ARGV[1])
if not current or current ~= expected then
  return {0, currentRaw or ''}
end

local mode = ARGV[2]
if mode == 'write' then
  redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
  redis.call('SET', KEYS[3], ARGV[5])
elseif mode == 'delete' then
  redis.call('HDEL', KEYS[2], ARGV[3])
  redis.call('DEL', KEYS[3])
end

local groupCount = tonumber(ARGV[6])
local argIndex = 7
for group = 1, groupCount do
  local ruleKey = KEYS[3 + group]
  local ruleCount = tonumber(ARGV[argIndex])
  argIndex = argIndex + 1
  for _ = 1, ruleCount do
    redis.call('HSET', ruleKey, ARGV[argIndex], ARGV[argIndex + 1])
    argIndex = argIndex + 2
  end
end

local nextVersion = redis.call('INCR', KEYS[1])
return {1, tostring(nextVersion)}
`.trim();

export interface RuleSetCommit {
  /** Upsert this record (meta into the hash, body into its own key). */
  write?: RuleSet;
  /** Remove this id (meta + body). Mutually exclusive with `write`. */
  deleteId?: string;
  /** Rename cascade: rules to rewrite, grouped by owning profile. */
  ruleWrites?: readonly { profileId: string; rules: readonly Rule[] }[];
}

export interface RuleSetCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

export async function commitRuleSetChange(
  change: RuleSetCommit,
  expectedVersion: number,
): Promise<RuleSetCommitResult> {
  const targetId = change.write?.id ?? change.deleteId;
  if (!targetId) {
    throw new Error('commitRuleSetChange requires either `write` or `deleteId`.');
  }
  const groups = (change.ruleWrites ?? []).filter((g) => g.rules.length > 0);

  const keys = [
    REDIS_KEYS.configVersion,
    REDIS_KEYS.ruleSets,
    REDIS_KEYS.ruleSetContent(targetId),
    ...groups.map((g) => REDIS_KEYS.rules(g.profileId)),
  ];
  const args: string[] = [
    String(expectedVersion),
    change.write ? 'write' : 'delete',
    targetId,
    change.write ? JSON.stringify(toMeta(change.write)) : '',
    change.write?.content ?? '',
    String(groups.length),
  ];
  for (const group of groups) {
    args.push(String(group.rules.length));
    for (const rule of group.rules) args.push(rule.id, JSON.stringify(rule));
  }

  const result = (await getRedis().eval(CAS_RULE_SET_CHANGE, keys, args)) as [number, string];
  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}
