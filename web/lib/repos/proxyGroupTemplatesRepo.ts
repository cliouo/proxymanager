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

export async function upsertProxyGroupTemplate(template: ProxyGroupTemplate): Promise<void> {
  await getRedis().hset(REDIS_KEYS.proxyGroupTemplates, { [template.id]: template });
}

export async function upsertProxyGroupTemplates(templates: ProxyGroupTemplate[]): Promise<void> {
  if (templates.length === 0) return;
  const payload: Record<string, ProxyGroupTemplate> = {};
  for (const t of templates) payload[t.id] = t;
  await getRedis().hset(REDIS_KEYS.proxyGroupTemplates, payload);
}

export async function deleteProxyGroupTemplate(id: string): Promise<boolean> {
  const removed = await getRedis().hdel(REDIS_KEYS.proxyGroupTemplates, id);
  return removed > 0;
}
