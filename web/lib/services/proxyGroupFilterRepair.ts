import { ProblemDetailsError } from '@/lib/http/problem';
import { compileGoRegex } from '@/lib/proxies/filterMatch';
import { ProxyGroupUpdateSchema, type ProxyGroup } from '@/schemas';

export interface ProxyGroupFilterRepair {
  id: string;
  filter?: string | null;
  'exclude-filter'?: string | null;
}

type FilterKey = 'filter' | 'exclude-filter';

function isInvalidStoredGroupRegex(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value.length > 4_096) return true;
  const patterns = value.split('`');
  if (patterns.length > 32 || patterns.some((pattern) => pattern.length === 0)) return true;
  try {
    for (const pattern of patterns) compileGoRegex(pattern);
    return false;
  } catch {
    return true;
  }
}

/**
 * Build filter-only replacements for already-invalid stored groups.
 *
 * This pure domain helper deliberately knows nothing about persistence or
 * whole-profile orchestration, so normal group repair and composite legacy
 * recovery share exactly the same eligibility and validation rules.
 */
export function buildFilterRepairWrites(
  allGroups: ProxyGroup[],
  repairs: ProxyGroupFilterRepair[],
  updatedAt = Math.floor(Date.now() / 1000),
): { before: ProxyGroup[]; after: ProxyGroup[] } {
  if (repairs.length < 2 || repairs.length > 16) {
    throw ProblemDetailsError.unprocessable('批量筛选修复需要 2 到 16 个策略组。');
  }

  const byId = new Map(allGroups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  for (const repair of repairs) {
    if (seen.has(repair.id)) {
      throw ProblemDetailsError.conflict(`批次内 proxy-group id 重复: ${repair.id}`);
    }
    seen.add(repair.id);
  }
  const before: ProxyGroup[] = [];
  const after = repairs.map((repair) => {
    const current = byId.get(repair.id);
    if (!current) {
      throw ProblemDetailsError.notFound(`proxy-group ${repair.id} 不存在。`);
    }
    if (repair.filter === undefined && repair['exclude-filter'] === undefined) {
      throw ProblemDetailsError.unprocessable(`proxy-group ${repair.id} 没有筛选字段需要修复。`);
    }

    const validated = ProxyGroupUpdateSchema.parse({
      filter: repair.filter,
      'exclude-filter': repair['exclude-filter'],
    });
    const changedKeys: FilterKey[] = [];
    for (const key of ['filter', 'exclude-filter'] as const) {
      const value = validated[key];
      if (value === undefined) continue;
      const normalized = value === null ? undefined : value;
      if (current[key] !== normalized) changedKeys.push(key);
    }
    if (changedKeys.length === 0) {
      throw ProblemDetailsError.unprocessable(`proxy-group ${repair.id} 的筛选字段没有变化。`);
    }
    if (!changedKeys.some((key) => isInvalidStoredGroupRegex(current[key]))) {
      throw ProblemDetailsError.unprocessable(
        `proxy-group ${repair.id} 当前没有被修复字段中的非法正则;请使用普通单组更新。`,
      );
    }

    const next: ProxyGroup = { ...current, updated_at: updatedAt };
    for (const [key, value] of Object.entries(validated)) {
      if (value === null) delete (next as Record<string, unknown>)[key];
      else if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    before.push(current);
    return next;
  });

  return { before, after };
}
