import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { SubscriptionSchema, type Subscription } from '@/schemas';

/**
 * Run stored rows through the Zod schema so defaults (kind, ttl_ms, tags)
 * are filled in for records persisted before the field existed. This is
 * the migration path — no separate one-shot script needed.
 */
function normalise(raw: unknown): Subscription | null {
  const parsed = SubscriptionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.subscriptions);
  if (!all) return [];
  const out: Subscription[] = [];
  for (const raw of Object.values(all)) {
    const sub = normalise(raw);
    if (sub) out.push(sub);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.subscriptions, id);
  return normalise(raw);
}

export async function getSubscriptionByName(name: string): Promise<Subscription | null> {
  const all = await listSubscriptions();
  return all.find((s) => s.name === name) ?? null;
}

// Writes bump config:version in the same multi() — subscription records
// (enabled/url/prefix/operators…) shape the rendered config. Note this also
// fires for pure runtime-state updates (last_synced_at / last_traffic);
// over-invalidation is safe, just an extra render.

export async function upsertSubscription(sub: Subscription): Promise<void> {
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.subscriptions, { [sub.id]: sub })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.subscriptions, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
