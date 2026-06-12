import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { CollectionSchema, type Collection } from '@/schemas';

function normalise(raw: unknown): Collection | null {
  const parsed = CollectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function listCollections(): Promise<Collection[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.collections);
  if (!all) return [];
  const out: Collection[] = [];
  for (const raw of Object.values(all)) {
    const c = normalise(raw);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCollection(id: string): Promise<Collection | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.collections, id);
  return normalise(raw);
}

export async function getCollectionByName(name: string): Promise<Collection | null> {
  const all = await listCollections();
  return all.find((c) => c.name === name) ?? null;
}

// Writes bump config:version in the same multi() — collections drive
// collection-scope proxy-groups and profile bindings in the rendered config.

export async function upsertCollection(col: Collection): Promise<void> {
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.collections, { [col.id]: col })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function deleteCollection(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.collections, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
