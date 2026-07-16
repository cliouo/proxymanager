import { ProblemDetailsError } from '@/lib/http/problem';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { getProxyGroup, getProxyGroupByName, listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { getProxyGroupTemplate } from '@/lib/repos/proxyGroupTemplatesRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';
import {
  ProxyGroupCreateSchema,
  ProxyGroupUpdateSchema,
  type ProxyGroup,
  type ProxyGroupCreate,
  type ProxyGroupUpdate,
  type Rule,
} from '@/schemas';

const RANK_STEP = 10;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Fire-and-forget snapshot invalidation. See subscriptionService for rationale. */
function invalidateSnapshot(): void {
  invalidateResolvedSnapshot().catch(() => undefined);
}

export function generateProxyGroupId(): string {
  return crypto.randomUUID();
}

async function assertTemplateExists(templateId: string | undefined): Promise<void> {
  if (!templateId) return;
  const tpl = await getProxyGroupTemplate(templateId);
  if (!tpl) {
    throw ProblemDetailsError.unprocessable(
      `template_id ${templateId} 不存在;请先创建模板或留空。`,
    );
  }
}

async function nextRank(profileId: string): Promise<number> {
  const all = await listProxyGroups(profileId);
  if (all.length === 0) return RANK_STEP;
  let max = 0;
  for (const g of all) if (g.rank > max) max = g.rank;
  return max + RANK_STEP;
}

/**
 * Refuse if applying `proposed` would create a `dialer-proxy` cycle. Only
 * dialer-proxy edges form runtime chains (`proxies[]` references can be a
 * legitimate DAG via layered selects). Walks from `proposed.name` following
 * dialer-proxy until either a dead end or a revisit.
 *
 * `existingGroups` should already have `proposed` excluded by the caller.
 */
function ensureNoDialerProxyCycle(existingGroups: ProxyGroup[], proposed: ProxyGroup): void {
  const edges = new Map<string, string>();
  for (const g of existingGroups) {
    if (g['dialer-proxy']) edges.set(g.name, g['dialer-proxy']);
  }
  if (proposed['dialer-proxy']) edges.set(proposed.name, proposed['dialer-proxy']);

  const visited = new Set<string>();
  let cur: string | undefined = proposed.name;
  while (cur) {
    if (visited.has(cur)) {
      throw ProblemDetailsError.unprocessable(`策略组循环引用: ${[...visited, cur].join(' → ')}`);
    }
    visited.add(cur);
    cur = edges.get(cur);
  }
}

/**
 * Cascade a rename across the project's other resources so dangling
 * references can't survive. Rewrites:
 *   - other groups' `proxies[]` entries
 *   - other groups' `dialer-proxy` field
 *   - rules whose `policy` matched the old name
 *
 * Base.yaml carries no group references after E1 (proxy-groups are in the
 * hash, rules block is markers-only), so this is the complete reach.
 */
function planCascadeRename(
  allGroups: readonly ProxyGroup[],
  allRules: readonly Rule[],
  oldName: string,
  newName: string,
  excludingId: string,
): {
  groupsTouched: number;
  rulesTouched: number;
  groupsToWrite: ProxyGroup[];
  rulesToWrite: Rule[];
} {
  const groupsToWrite: ProxyGroup[] = [];
  for (const g of allGroups) {
    if (g.id === excludingId) continue;
    let next = g;
    let mutated = false;
    if (Array.isArray(g.proxies)) {
      const proxies = g.proxies.map((p) => (p === oldName ? newName : p));
      if (proxies.some((p, i) => p !== g.proxies![i])) {
        next = { ...next, proxies };
        mutated = true;
      }
    }
    if (g['dialer-proxy'] === oldName) {
      next = { ...next, 'dialer-proxy': newName };
      mutated = true;
    }
    if (mutated) {
      groupsToWrite.push({ ...next, updated_at: nowSeconds() });
    }
  }

  const rulesToWrite: Rule[] = [];
  for (const r of allRules) {
    if (r.policy === oldName) {
      rulesToWrite.push({ ...r, policy: newName, updated_at: nowSeconds() });
    }
  }

  return {
    groupsTouched: groupsToWrite.length,
    rulesTouched: rulesToWrite.length,
    groupsToWrite,
    rulesToWrite,
  };
}

/**
 * Refuse deletion of a group still referenced by another group's `proxies[]`
 * or `dialer-proxy`, or by a Rule's `policy`. Silent cascade would either
 * leave dangling refs (mihomo refuses to load) or surprise the user by
 * unwiring their rules — better to make them clean up explicitly.
 */
async function ensureUnreferenced(
  profileId: string,
  name: string,
  excludingId: string,
): Promise<void> {
  const [allGroups, allRules] = await Promise.all([
    listProxyGroups(profileId),
    listRules(profileId),
  ]);
  const refs: string[] = [];
  for (const g of allGroups) {
    if (g.id === excludingId) continue;
    if (Array.isArray(g.proxies) && g.proxies.includes(name)) {
      refs.push(`策略组 "${g.name}".proxies`);
    }
    if (g['dialer-proxy'] === name) {
      refs.push(`策略组 "${g.name}".dialer-proxy`);
    }
  }
  for (const r of allRules) {
    if (r.policy === name) refs.push(`规则 ${r.id}.policy`);
  }
  if (refs.length > 0) {
    const head = refs.slice(0, 5).join(', ');
    const tail = refs.length > 5 ? ` 等 ${refs.length} 处` : '';
    throw ProblemDetailsError.conflict(`策略组 "${name}" 仍被引用,无法删除: ${head}${tail}`);
  }
}

export async function createProxyGroup(
  profileId: string,
  input: ProxyGroupCreate,
  expectedPlanningVersion?: number,
): Promise<ProxyGroup> {
  const parsed = ProxyGroupCreateSchema.parse(input);
  const planningVersion = expectedPlanningVersion ?? (await getConfigVersion());
  const dup = await getProxyGroupByName(profileId, parsed.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`proxy-group 名称 "${parsed.name}" 已存在。`);
  }
  await assertTemplateExists(parsed.template_id);
  const now = nowSeconds();
  const rank = parsed.rank ?? (await nextRank(profileId));
  const group: ProxyGroup = {
    ...parsed,
    id: generateProxyGroupId(),
    rank,
    created_at: now,
    updated_at: now,
  } as ProxyGroup;

  // Cycle check against everyone EXCEPT this group (it's brand new).
  const allGroups = await listProxyGroups(profileId);
  ensureNoDialerProxyCycle(allGroups, group);

  await preflightAndCommitProfileChanges(profileId, { proxyGroupWrites: [group] }, planningVersion);
  invalidateSnapshot();
  return group;
}

/**
 * Patch a proxy-group. `null` in a nullable optional field clears the field
 * (e.g., `notes: null` removes the note). A rename cascades to other
 * groups' proxies/dialer-proxy and to rule policies in one batch.
 */
export async function patchProxyGroup(
  profileId: string,
  id: string,
  patch: ProxyGroupUpdate,
  expectedPlanningVersion?: number,
): Promise<ProxyGroup> {
  const validated = ProxyGroupUpdateSchema.parse(patch);
  const planningVersion = expectedPlanningVersion ?? (await getConfigVersion());
  const current = await getProxyGroup(profileId, id);
  if (!current) {
    throw ProblemDetailsError.notFound(`proxy-group ${id} 不存在。`);
  }
  const renaming = !!(validated.name && validated.name !== current.name);
  if (renaming) {
    const dup = await getProxyGroupByName(profileId, validated.name!);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`proxy-group 名称 "${validated.name}" 已存在。`);
    }
  }
  if (validated.template_id) {
    await assertTemplateExists(validated.template_id);
  }

  const next: ProxyGroup = { ...current, updated_at: nowSeconds() };
  for (const [k, v] of Object.entries(validated)) {
    if (v === null) {
      delete (next as Record<string, unknown>)[k];
    } else if (v !== undefined) {
      (next as Record<string, unknown>)[k] = v;
    }
  }

  // Cycle check uses the patched form vs. every other group.
  const allGroups = await listProxyGroups(profileId);
  const others = allGroups.filter((g) => g.id !== id);
  ensureNoDialerProxyCycle(others, next);

  let groupWrites: ProxyGroup[] = [next];
  let ruleWrites: Rule[] = [];
  if (renaming) {
    const allRules = await listRules(profileId);
    const cascade = planCascadeRename(allGroups, allRules, current.name, next.name, id);
    groupWrites = [...cascade.groupsToWrite, next];
    ruleWrites = cascade.rulesToWrite;
  }
  // The renamed group and every name-based reference land in one CAS commit;
  // neither readers nor a concurrent writer can observe a half-cascade.
  await preflightAndCommitProfileChanges(
    profileId,
    {
      proxyGroupWrites: groupWrites,
      ruleWrites,
    },
    planningVersion,
  );
  invalidateSnapshot();
  return next;
}

export async function deleteProxyGroup(
  profileId: string,
  id: string,
  expectedPlanningVersion?: number,
): Promise<boolean> {
  const planningVersion = expectedPlanningVersion ?? (await getConfigVersion());
  const current = await getProxyGroup(profileId, id);
  if (!current) return false;
  await ensureUnreferenced(profileId, current.name, id);
  await preflightAndCommitProfileChanges(profileId, { proxyGroupDeletes: [id] }, planningVersion);
  invalidateSnapshot();
  return true;
}

/**
 * Batch-create multiple groups in one shot — used by scenarios that emit
 * pairs (e.g. chained-proxy's pool + wrap). Validates name uniqueness across
 * the batch AND against the existing hash, checks templates, then runs
 * dialer-proxy cycle detection on the combined final state before writing.
 * One Redis hset → one snapshot invalidation.
 */
export async function createProxyGroups(
  profileId: string,
  inputs: ProxyGroupCreate[],
  expectedPlanningVersion?: number,
): Promise<ProxyGroup[]> {
  if (inputs.length === 0) return [];

  const parsed = inputs.map((i) => ProxyGroupCreateSchema.parse(i));
  const planningVersion = expectedPlanningVersion ?? (await getConfigVersion());

  // Within-batch name uniqueness.
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.name)) {
      throw ProblemDetailsError.conflict(`批次内 proxy-group 名称重复: "${p.name}"`);
    }
    seen.add(p.name);
  }
  const existingByName = new Map((await listProxyGroups(profileId)).map((g) => [g.name, g]));
  for (const p of parsed) {
    if (existingByName.has(p.name)) {
      throw ProblemDetailsError.conflict(`proxy-group 名称 "${p.name}" 已存在。`);
    }
  }

  // Templates.
  for (const p of parsed) {
    await assertTemplateExists(p.template_id);
  }

  // Build groups with rank assignment.
  const now = nowSeconds();
  let cursor = await nextRank(profileId);
  const built: ProxyGroup[] = parsed.map((p) => {
    const rank = p.rank ?? cursor;
    if (p.rank === undefined) cursor += RANK_STEP;
    return {
      ...p,
      id: generateProxyGroupId(),
      rank,
      created_at: now,
      updated_at: now,
    } as ProxyGroup;
  });

  // Cycle check on combined final state: existing groups + the new batch.
  const existing = Array.from(existingByName.values());
  const combined = [...existing, ...built];
  for (const g of built) {
    // Each new group's dialer-proxy chain must not loop against the rest.
    const others = combined.filter((c) => c.id !== g.id);
    ensureNoDialerProxyCycle(others, g);
  }

  await preflightAndCommitProfileChanges(profileId, { proxyGroupWrites: built }, planningVersion);
  invalidateSnapshot();
  return built;
}

/**
 * Bulk-delete a set of groups by name. Reference checks consider the SET as
 * a whole: a member of the batch may freely reference another member (e.g.
 * a wrap group referencing a pool group both being deleted), but anything
 * outside the batch must not reference any of them.
 */
export async function deleteProxyGroupsByName(
  profileId: string,
  names: string[],
  expectedPlanningVersion?: number,
): Promise<number> {
  if (names.length === 0) return 0;
  const planningVersion = expectedPlanningVersion ?? (await getConfigVersion());
  const nameSet = new Set(names);
  const [allGroups, allRules] = await Promise.all([
    listProxyGroups(profileId),
    listRules(profileId),
  ]);
  const idsToDelete = allGroups.filter((g) => nameSet.has(g.name)).map((g) => g.id);
  if (idsToDelete.length === 0) return 0;
  const idSet = new Set(idsToDelete);

  const refs: string[] = [];
  for (const g of allGroups) {
    if (idSet.has(g.id)) continue;
    if (Array.isArray(g.proxies)) {
      for (const p of g.proxies) {
        if (nameSet.has(p)) refs.push(`策略组 "${g.name}".proxies → "${p}"`);
      }
    }
    if (g['dialer-proxy'] && nameSet.has(g['dialer-proxy'])) {
      refs.push(`策略组 "${g.name}".dialer-proxy → "${g['dialer-proxy']}"`);
    }
  }
  for (const r of allRules) {
    if (nameSet.has(r.policy)) refs.push(`规则 ${r.id}.policy → "${r.policy}"`);
  }
  if (refs.length > 0) {
    const head = refs.slice(0, 5).join(', ');
    const tail = refs.length > 5 ? ` 等 ${refs.length} 处` : '';
    throw ProblemDetailsError.conflict(`策略组仍被批次外引用,无法删除: ${head}${tail}`);
  }

  await preflightAndCommitProfileChanges(
    profileId,
    { proxyGroupDeletes: idsToDelete },
    planningVersion,
  );
  invalidateSnapshot();
  return idsToDelete.length;
}

export { listProxyGroups, getProxyGroup, getProxyGroupByName };
