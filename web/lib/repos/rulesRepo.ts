import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Rule } from '@/schemas';

// Every write below bundles an INCR on config:version into the same multi()
// — rules feed the rendered config, so the render cache must be invalidated
// atomically with the write (see lib/repos/configVersionRepo.ts).

export async function listRules(): Promise<Rule[]> {
  const all = await getRedis().hgetall<Record<string, Rule>>(REDIS_KEYS.rules);
  if (!all) return [];
  return Object.values(all);
}

export async function getRule(id: string): Promise<Rule | null> {
  const value = await getRedis().hget<Rule>(REDIS_KEYS.rules, id);
  return value ?? null;
}

export async function upsertRule(rule: Rule): Promise<void> {
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.rules, { [rule.id]: rule })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function upsertRules(rules: Rule[]): Promise<void> {
  if (rules.length === 0) return;
  const payload: Record<string, Rule> = {};
  for (const rule of rules) payload[rule.id] = rule;
  await getRedis().multi().hset(REDIS_KEYS.rules, payload).incr(REDIS_KEYS.configVersion).exec();
}

export async function deleteRule(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.rules, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}

export async function deleteRules(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.rules, ...ids)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed;
}

export async function clearRules(): Promise<void> {
  await getRedis().multi().del(REDIS_KEYS.rules).incr(REDIS_KEYS.configVersion).exec();
}

export async function batchUpsertAndDelete(writes: Rule[], removes: string[]): Promise<void> {
  if (writes.length === 0 && removes.length === 0) return;
  const tx = getRedis().multi();
  if (writes.length > 0) {
    const payload: Record<string, Rule> = {};
    for (const rule of writes) payload[rule.id] = rule;
    tx.hset(REDIS_KEYS.rules, payload);
  }
  if (removes.length > 0) {
    tx.hdel(REDIS_KEYS.rules, ...removes);
  }
  tx.incr(REDIS_KEYS.configVersion);
  await tx.exec();
}
