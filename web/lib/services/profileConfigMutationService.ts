import { ProblemDetailsError } from '@/lib/http/problem';
import {
  commitProfileConfigChanges,
  type ProfileConfigChanges,
} from '@/lib/repos/profileConfigMutationRepo';
import { sortProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import {
  applyConfigEntityChanges,
  preflightProfileConfig,
  type ProfileConfigState,
} from '@/lib/services/configPreflight';

/**
 * Preflight and atomically commit a rules/proxy-groups mutation. Callers hand
 * over the exact id-keyed writes/deletes they intend to persist; the helper
 * derives the complete candidate from a stable snapshot, renders it in memory,
 * then commits only if config:version is unchanged.
 */
export async function preflightAndCommitProfileChanges(
  profileId: string,
  changes: ProfileConfigChanges,
  expectedPlanningVersion?: number,
): Promise<ProfileConfigState> {
  const checked = await preflightProfileConfig(profileId, (current) => ({
    rules: applyConfigEntityChanges(
      current.rules,
      changes.ruleWrites ?? [],
      changes.ruleDeletes ?? [],
    ),
    proxyGroups: sortProxyGroups(
      applyConfigEntityChanges(
        current.proxyGroups,
        changes.proxyGroupWrites ?? [],
        changes.proxyGroupDeletes ?? [],
      ),
    ),
  }));

  if (expectedPlanningVersion !== undefined && checked.configVersion !== expectedPlanningVersion) {
    throw ProblemDetailsError.preconditionFailed(
      '配置在生成保存候选期间被其他写入修改,请刷新后重试。',
    );
  }

  const committed = await commitProfileConfigChanges(profileId, changes, checked.configVersion);
  if (!committed.ok) {
    throw ProblemDetailsError.preconditionFailed(
      '配置在保存前校验期间被其他写入修改,请刷新后重试。',
    );
  }
  return checked.candidate;
}
