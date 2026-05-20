import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { RuleSet } from '@/schemas';

export async function listRuleSets(): Promise<RuleSet[]> {
  const all = await getRedis().hgetall<Record<string, RuleSet>>(REDIS_KEYS.ruleSets);
  if (!all) return [];
  return Object.values(all).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRuleSet(id: string): Promise<RuleSet | null> {
  const value = await getRedis().hget<RuleSet>(REDIS_KEYS.ruleSets, id);
  return value ?? null;
}

export async function getRuleSetByName(name: string): Promise<RuleSet | null> {
  const all = await listRuleSets();
  return all.find((s) => s.name === name) ?? null;
}

export async function upsertRuleSet(set: RuleSet): Promise<void> {
  await getRedis().hset(REDIS_KEYS.ruleSets, { [set.id]: set });
}

export async function deleteRuleSet(id: string): Promise<boolean> {
  const removed = await getRedis().hdel(REDIS_KEYS.ruleSets, id);
  return removed > 0;
}
