import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Subscription } from '@/schemas';

export async function listSubscriptions(): Promise<Subscription[]> {
  const all = await getRedis().hgetall<Record<string, Subscription>>(REDIS_KEYS.subscriptions);
  if (!all) return [];
  return Object.values(all).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const value = await getRedis().hget<Subscription>(REDIS_KEYS.subscriptions, id);
  return value ?? null;
}

export async function getSubscriptionByName(name: string): Promise<Subscription | null> {
  const all = await listSubscriptions();
  return all.find((s) => s.name === name) ?? null;
}

export async function upsertSubscription(sub: Subscription): Promise<void> {
  await getRedis().hset(REDIS_KEYS.subscriptions, { [sub.id]: sub });
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const removed = await getRedis().hdel(REDIS_KEYS.subscriptions, id);
  return removed > 0;
}
