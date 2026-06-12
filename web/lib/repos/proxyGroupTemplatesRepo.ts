import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { ProxyGroupTemplateSchema, type ProxyGroupTemplate } from '@/schemas';

function normalise(raw: unknown): ProxyGroupTemplate | null {
  const parsed = ProxyGroupTemplateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function listProxyGroupTemplates(): Promise<ProxyGroupTemplate[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.proxyGroupTemplates);
  if (!all) return [];
  const out: ProxyGroupTemplate[] = [];
  for (const raw of Object.values(all)) {
    const t = normalise(raw);
    if (t) out.push(t);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProxyGroupTemplate(id: string): Promise<ProxyGroupTemplate | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.proxyGroupTemplates, id);
  return normalise(raw);
}

export async function getProxyGroupTemplateByName(
  name: string,
): Promise<ProxyGroupTemplate | null> {
  const all = await listProxyGroupTemplates();
  return all.find((t) => t.name === name) ?? null;
}

// Writes bump config:version in the same multi() — templates are merged
// underneath proxy-groups at render time, so edits change the output.

export async function upsertProxyGroupTemplate(template: ProxyGroupTemplate): Promise<void> {
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.proxyGroupTemplates, { [template.id]: template })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function upsertProxyGroupTemplates(templates: ProxyGroupTemplate[]): Promise<void> {
  if (templates.length === 0) return;
  const payload: Record<string, ProxyGroupTemplate> = {};
  for (const t of templates) payload[t.id] = t;
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.proxyGroupTemplates, payload)
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

export async function deleteProxyGroupTemplate(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.proxyGroupTemplates, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
