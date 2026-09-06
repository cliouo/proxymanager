import { ProblemDetailsError } from '@/lib/http/problem';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { recordEvent } from '@/lib/repos/auditRepo';
import { preflightAndCommitProfileChanges } from './profileConfigMutationService';
import { versionedRead } from './versionedRead';
import { compareRulesForEffectiveOrder } from '@/schemas/rule';

export async function reorderProxyGroups(
  profileId: string,
  orderedIds: string[],
  expectedVersion: number,
  actor: string,
) {
  const snapshot = await versionedRead(() => listProxyGroups(profileId));
  if (snapshot.configVersion !== expectedVersion)
    throw ProblemDetailsError.preconditionFailed('排序已过期，请刷新后重试。');
  const byId = new Map(snapshot.data.map((g) => [g.id, g]));
  if (
    orderedIds.length !== byId.size ||
    new Set(orderedIds).size !== byId.size ||
    orderedIds.some((id) => !byId.has(id))
  ) {
    throw ProblemDetailsError.unprocessable(
      'orderedIds 必须包含当前配置的全部策略组，且每个 ID 只能出现一次。',
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const writes = orderedIds.map((id, i) => ({
    ...byId.get(id)!,
    rank: (i + 1) * 10,
    updated_at: now,
  }));
  await preflightAndCommitProfileChanges(profileId, { proxyGroupWrites: writes }, expectedVersion);
  await recordEvent({
    op: 'proxy-groups.reorder',
    actor,
    profileId,
    target: { kind: 'profile' },
    undoable: false,
    before: snapshot.data.map(({ id, rank }) => ({ id, rank })),
    after: writes.map(({ id, rank }) => ({ id, rank })),
  });
  return writes;
}

export async function moveRule(
  profileId: string,
  id: string,
  direction: 'up' | 'down',
  expectedVersion: number,
  actor: string,
) {
  const snapshot = await versionedRead(() => listRules(profileId));
  if (snapshot.configVersion !== expectedVersion)
    throw ProblemDetailsError.preconditionFailed('规则顺序已过期，请刷新后重试。');
  const rule = snapshot.data.find((r) => r.id === id);
  if (!rule) throw ProblemDetailsError.notFound('规则不存在。');
  const ordered = snapshot.data
    .filter((r) => r.anchor === rule.anchor)
    .sort(compareRulesForEffectiveOrder);
  const from = ordered.findIndex((r) => r.id === id);
  const to = from + (direction === 'up' ? -1 : 1);
  if (to < 0 || to >= ordered.length) return ordered;
  if ([ordered[from], ordered[to]].some((r) => r.type === 'MATCH' && r.enabled !== false)) {
    throw ProblemDetailsError.unprocessable('MATCH 必须保持为最后一条生效规则。');
  }
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const now = Math.floor(Date.now() / 1000);
  const writes = ordered.map((r, i) => ({ ...r, rank: (i + 1) * 10, updated_at: now }));
  await preflightAndCommitProfileChanges(profileId, { ruleWrites: writes }, expectedVersion);
  await recordEvent({
    op: 'rules.move',
    actor,
    profileId,
    target: { kind: 'profile' },
    undoable: false,
    before: snapshot.data
      .filter((r) => r.anchor === rule.anchor)
      .map(({ id, rank }) => ({ id, rank })),
    after: writes.map(({ id, rank }) => ({ id, rank })),
  });
  return writes;
}
