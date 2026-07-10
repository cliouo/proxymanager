import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { ProxyGroupSchema, type ProxyGroup } from '@/schemas';

function normalise(raw: unknown): ProxyGroup | null {
  const parsed = ProxyGroupSchema.safeParse(raw);
  if (!parsed.success) {
    // P3-10: don't silently drop a corrupt record — an invisible disappearing
    // proxy-group is far harder to diagnose than a log line.
    const name = (raw as { name?: unknown })?.name;
    console.warn(
      `[proxyGroupsRepo] skipping unparseable proxy-group${
        typeof name === 'string' ? ` "${name}"` : ''
      }: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
    return null;
  }
  return parsed.data;
}

/** Sort by `rank` ascending so render order matches storage. Ties broken by name for determinism. */
function byRank(a: ProxyGroup, b: ProxyGroup): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.name.localeCompare(b.name);
}

export async function listProxyGroups(profileId: string): Promise<ProxyGroup[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.proxyGroups(profileId));
  if (!all) return [];
  const out: ProxyGroup[] = [];
  for (const raw of Object.values(all)) {
    const g = normalise(raw);
    if (g) out.push(g);
  }
  return out.sort(byRank);
}

export async function getProxyGroup(profileId: string, id: string): Promise<ProxyGroup | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.proxyGroups(profileId), id);
  return normalise(raw);
}

export async function getProxyGroupByName(
  profileId: string,
  name: string,
): Promise<ProxyGroup | null> {
  const all = await listProxyGroups(profileId);
  return all.find((g) => g.name === name) ?? null;
}

// Writes bump config:version in the same multi() — proxy-groups are emitted
// verbatim into the rendered config's PROXY-GROUPS block.

export async function upsertProxyGroup(profileId: string, group: ProxyGroup): Promise<void> {
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.proxyGroups(profileId), { [group.id]: group })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function upsertProxyGroups(profileId: string, groups: ProxyGroup[]): Promise<void> {
  if (groups.length === 0) return;
  const payload: Record<string, ProxyGroup> = {};
  for (const g of groups) payload[g.id] = g;
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.proxyGroups(profileId), payload)
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function deleteProxyGroup(profileId: string, id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.proxyGroups(profileId), id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
