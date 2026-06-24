import { ProblemDetailsError } from '@/lib/http/problem';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import {
  deleteProxyGroupTemplate as repoDelete,
  getProxyGroupTemplate,
  getProxyGroupTemplateByName,
  listProxyGroupTemplates,
  upsertProxyGroupTemplate,
} from '@/lib/repos/proxyGroupTemplatesRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import {
  ProxyGroupTemplateCreateSchema,
  ProxyGroupTemplateUpdateSchema,
  type ProxyGroupTemplate,
  type ProxyGroupTemplateCreate,
  type ProxyGroupTemplateUpdate,
} from '@/schemas';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function invalidateSnapshot(): void {
  invalidateResolvedSnapshot().catch(() => undefined);
}

export function generateProxyGroupTemplateId(): string {
  return crypto.randomUUID();
}

export async function createProxyGroupTemplate(
  input: ProxyGroupTemplateCreate,
): Promise<ProxyGroupTemplate> {
  const parsed = ProxyGroupTemplateCreateSchema.parse(input);
  const dup = await getProxyGroupTemplateByName(parsed.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`proxy-group template "${parsed.name}" 已存在。`);
  }
  const tpl: ProxyGroupTemplate = {
    id: generateProxyGroupTemplateId(),
    updated_at: nowSeconds(),
    ...parsed,
  };
  await upsertProxyGroupTemplate(tpl);
  invalidateSnapshot();
  return tpl;
}

export async function patchProxyGroupTemplate(
  id: string,
  patch: ProxyGroupTemplateUpdate,
): Promise<ProxyGroupTemplate> {
  const validated = ProxyGroupTemplateUpdateSchema.parse(patch);
  const current = await getProxyGroupTemplate(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`proxy-group template ${id} 不存在。`);
  }
  if (validated.name && validated.name !== current.name) {
    const dup = await getProxyGroupTemplateByName(validated.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`proxy-group template "${validated.name}" 已存在。`);
    }
  }
  const next: ProxyGroupTemplate = { ...current, updated_at: nowSeconds() };
  for (const [k, v] of Object.entries(validated)) {
    if (v === null) {
      delete (next as Record<string, unknown>)[k];
    } else if (v !== undefined) {
      (next as Record<string, unknown>)[k] = v;
    }
  }
  await upsertProxyGroupTemplate(next);
  invalidateSnapshot();
  return next;
}

/**
 * Refuse to delete a template still referenced by any group. The caller
 * should detach the references first (clear `template_id`) — silent
 * cascade would let groups suddenly fall back to no-defaults, breaking
 * url-test groups that rely on the shared `url`/`interval`.
 *
 * Templates are a SHARED library (Phase 2): a group in ANY profile may
 * reference one, so the reference scan walks every profile's proxy-groups.
 */
export async function deleteProxyGroupTemplate(id: string): Promise<boolean> {
  const profiles = await listProfiles();
  const groupLists = await Promise.all(profiles.map((p) => listProxyGroups(p.id)));
  const referenced = groupLists
    .flat()
    .filter((g) => g.template_id === id)
    .map((g) => g.name);
  if (referenced.length > 0) {
    const uniq = Array.from(new Set(referenced));
    throw ProblemDetailsError.conflict(
      `模板仍被 ${uniq.length} 个策略组引用,无法删除: ${uniq.join(', ')}`,
    );
  }
  const removed = await repoDelete(id);
  if (removed) invalidateSnapshot();
  return removed;
}

export { listProxyGroupTemplates, getProxyGroupTemplate, getProxyGroupTemplateByName };
