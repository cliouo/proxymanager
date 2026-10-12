import { getConfigVersion } from './configVersionRepo';
import { commitProfileConfigChanges } from './profileConfigMutationRepo';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Rule } from '@/schemas';

// Writes change config:version atomically; upserts assign that committed generation
// as the entity revision, including script/clone callers outside the save service.

export async function listRules(profileId: string): Promise<Rule[]> {
  const all = await getRedis().hgetall<Record<string, Rule>>(REDIS_KEYS.rules(profileId));
  if (!all) return [];
  return Object.values(all);
}

export async function getRule(profileId: string, id: string): Promise<Rule | null> {
  const value = await getRedis().hget<Rule>(REDIS_KEYS.rules(profileId), id);
  return value ?? null;
}

export async function upsertRule(profileId: string, rule: Rule): Promise<void> {
  await batchUpsertAndDelete(profileId, [rule], []);
}
export async function upsertRules(profileId: string, rules: Rule[]): Promise<void> {
  await batchUpsertAndDelete(profileId, rules, []);
}

export async function deleteRule(profileId: string, id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.rules(profileId), id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}

export async function deleteRules(profileId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.rules(profileId), ...ids)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed;
}

export async function clearRules(profileId: string): Promise<void> {
  await getRedis().multi().del(REDIS_KEYS.rules(profileId)).incr(REDIS_KEYS.configVersion).exec();
}

export async function batchUpsertAndDelete(
  profileId: string,
  writes: Rule[],
  removes: string[],
): Promise<void> {
  if (writes.length === 0 && removes.length === 0) return;
  const version = await getConfigVersion();
  for (const rule of writes) rule.revision = version + 1;
  const result = await commitProfileConfigChanges(
    profileId,
    { ruleWrites: writes, ruleDeletes: removes },
    version,
  );
  if (!result.ok) throw ProblemDetailsError.preconditionFailed('规则在写入期间发生变化，请重试。');
}
