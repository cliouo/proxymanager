import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { ProxyGroupSchema, type ProxyGroup } from '@/schemas';

function normalise(raw: unknown): ProxyGroup | null {
  const parsed = ProxyGroupSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Sort by `rank` ascending so render order matches storage. Ties broken by name for determinism. */
function byRank(a: ProxyGroup, b: ProxyGroup): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.name.localeCompare(b.name);
}

export async function listProxyGroups(): Promise<ProxyGroup[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.proxyGroups);
  if (!all) return [];
  const out: ProxyGroup[] = [];
  for (const raw of Object.values(all)) {
    const g = normalise(raw);
    if (g) out.push(g);
  }
  return out.sort(byRank);
}

export async function getProxyGroup(id: string): Promise<ProxyGroup | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.proxyGroups, id);
  return normalise(raw);
}

export async function getProxyGroupByName(name: string): Promise<ProxyGroup | null> {
  const all = await listProxyGroups();
  return all.find((g) => g.name === name) ?? null;
}

// Writes bump config:version in the same multi() — proxy-groups are emitted
// verbatim into the rendered config's PROXY-GROUPS block.

export async function upsertProxyGroup(group: ProxyGroup): Promise<void> {
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.proxyGroups, { [group.id]: group })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function upsertProxyGroups(groups: ProxyGroup[]): Promise<void> {
  if (groups.length === 0) return;
  const payload: Record<string, ProxyGroup> = {};
  for (const g of groups) payload[g.id] = g;
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.proxyGroups, payload)
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function deleteProxyGroup(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.proxyGroups, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
