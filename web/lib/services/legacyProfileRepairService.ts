/**
 * Cross-resource recovery for a narrow legacy deadlock: a redundant direct
 * alias and multiple already-invalid group filters must become valid in the
 * same candidate or strict whole-profile preflight rejects either partial fix.
 */

import { ClientSafeProblemDetailsError } from '@/lib/http/problem';
import type { BaseRecord } from '@/lib/repos/baseRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import {
  BUILTIN_DIRECT,
  assertNoSharedProviderAlias,
  buildDirectAliasCandidate,
  loadDirectMigrationState,
  validateDirectMigrationCandidate,
  type DirectMigrationCandidate,
  type DirectMigrationSummary,
} from '@/lib/services/directMigrationService';
import { commitAtomicProfileConfig } from '@/lib/services/profileAtomicCommitService';
import {
  buildFilterRepairWrites,
  type ProxyGroupFilterRepair,
} from '@/lib/services/proxyGroupFilterRepair';
import type { ProxyGroup, ProxyGroupTemplate, Rule } from '@/schemas';

interface LegacyProfileRepairCandidate extends DirectMigrationCandidate {
  filterRepairBefore: ProxyGroup[];
  filterRepairAfter: ProxyGroup[];
}

export interface LegacyProfileRepairPlan extends LegacyProfileRepairCandidate {
  expectedVersion: number;
  expectedBaseEtag: string;
}

export interface LegacyProfileRepairSummary extends DirectMigrationSummary {
  repairedFilterGroups: string[];
}

function conflictForVersion(expected: number, current: number): ClientSafeProblemDetailsError {
  return ClientSafeProblemDetailsError.conflict(
    `配置在恢复预览后发生了变化（预期版本 ${expected}，当前版本 ${current}），请重新预览。`,
  );
}

export function buildLegacyProfileRepairCandidate(input: {
  base: BaseRecord;
  groups: ProxyGroup[];
  rules: Rule[];
  templates: ProxyGroupTemplate[];
  alias: string;
  repairs: ProxyGroupFilterRepair[];
  updatedAt?: number;
}): LegacyProfileRepairCandidate {
  const updatedAt = input.updatedAt ?? Math.floor(Date.now() / 1000);
  const directCandidate = buildDirectAliasCandidate({
    base: input.base,
    groups: input.groups,
    rules: input.rules,
    templates: input.templates,
    alias: input.alias,
    updatedAt,
  });
  const directById = new Map(directCandidate.groups.map((group) => [group.id, group]));
  const groupsAfterAlias = input.groups.map((group) => directById.get(group.id) ?? group);
  const filterPlan = buildFilterRepairWrites(groupsAfterAlias, input.repairs, updatedAt);
  const touched = new Map(directCandidate.groups.map((group) => [group.id, group]));
  for (const group of filterPlan.after) touched.set(group.id, group);

  return {
    ...directCandidate,
    groups: [...touched.values()],
    filterRepairBefore: filterPlan.before,
    filterRepairAfter: filterPlan.after,
  };
}

export async function planLegacyProfileRepair(
  profileId: string,
  alias: string,
  repairs: ProxyGroupFilterRepair[],
  expectedVersion?: number,
  expectedBaseEtag?: string,
): Promise<LegacyProfileRepairPlan> {
  const state = await loadDirectMigrationState(profileId, expectedVersion);
  if (expectedBaseEtag !== undefined && state.base.etag !== expectedBaseEtag) {
    throw ClientSafeProblemDetailsError.conflict(
      'base.yaml 与恢复预览时的 ETag 不一致，请重新预览。',
    );
  }
  assertNoSharedProviderAlias(state, alias);
  const candidate = buildLegacyProfileRepairCandidate({
    base: state.base,
    groups: state.groups,
    rules: state.rules,
    templates: state.templates,
    alias,
    repairs,
  });
  await validateDirectMigrationCandidate(state, candidate);
  const afterValidation = await getConfigVersion();
  if (afterValidation !== state.version) throw conflictForVersion(state.version, afterValidation);
  return {
    ...candidate,
    expectedVersion: state.version,
    expectedBaseEtag: state.base.etag,
  };
}

function filterAuditSnapshot(groups: ProxyGroup[]) {
  return groups.map((group) => ({
    name: group.name,
    filter: group.filter ?? null,
    excludeFilter: group['exclude-filter'] ?? null,
  }));
}

export async function executeLegacyProfileRepair(
  profileId: string,
  alias: string,
  repairs: ProxyGroupFilterRepair[],
  expectedVersion: number,
  expectedBaseEtag: string,
  actor: string,
): Promise<{ summary: LegacyProfileRepairSummary; newVersion: number; auditEventId: string }> {
  const plan = await planLegacyProfileRepair(
    profileId,
    alias,
    repairs,
    expectedVersion,
    expectedBaseEtag,
  );
  const repairedFilterGroups = plan.filterRepairAfter.map((group) => group.name);
  const { newVersion, auditEventId } = await commitAtomicProfileConfig(profileId, actor, plan, {
    op: 'legacy-profile-repair.apply',
    target: { kind: 'profile' },
    before: {
      directAlias: {
        name: plan.summary.alias,
        fields: plan.summary.removedProxyFields,
      },
      filters: filterAuditSnapshot(plan.filterRepairBefore),
    },
    after: {
      directReplacement: BUILTIN_DIRECT,
      filters: filterAuditSnapshot(plan.filterRepairAfter),
    },
    undoable: false,
  });
  return {
    summary: {
      ...plan.summary,
      expectedVersion: plan.expectedVersion,
      repairedFilterGroups,
    },
    newVersion,
    auditEventId,
  };
}
