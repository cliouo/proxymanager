/**
 * Narrow recovery helpers for legacy profiles whose final chain validation is
 * blocked by source compatibility errors or a stale generated chain pair.
 * This module deliberately does not weaken chain validation.
 */

import { ClientSafeProblemDetailsError } from '@/lib/http/problem';
import { parseBase } from '@/lib/engine/parser';
import { resolveConfig } from '@/lib/engine/resolve';
import { validateBase } from '@/lib/engine/validator';
import { parseProxyUriList } from '@/lib/proxies/uriToClash';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import {
  assertNoSharedProviderAlias,
  loadDirectMigrationState,
  type DirectMigrationSummary,
} from '@/lib/services/directMigrationService';
import { buildLegacyProfileRepairCandidate } from '@/lib/services/legacyProfileRepairService';
import { commitAtomicProfileRecovery } from '@/lib/services/profileRecoveryAtomicCommitService';
import type { ProxyGroupFilterRepair } from '@/lib/services/proxyGroupFilterRepair';
import { parseLocalProxies } from '@/lib/services/subscriptionFetcher';
import { resolveSubscriptionForPreflight } from '@/lib/services/configPreflight';
import {
  computeEtag,
  ruleProvidersBlockViolations,
  rulesBlockViolations,
} from '@/lib/services/baseService';
import { resolveCollectionMemberSubs } from '@/lib/engine/resolve';
import type { Profile, ProxyGroup, Rule, Subscription } from '@/schemas';

export interface SpxQuarantineSummary {
  sourceName: string;
  quarantineName: string;
  quarantinedNodes: number;
  affectedProfiles?: string[];
}

export interface SpxQuarantineResult {
  source: Subscription;
  quarantine: Subscription;
  summary: SpxQuarantineSummary;
}

export function buildSpxQuarantine(input: {
  source: Subscription;
  allSubscriptions: readonly Subscription[];
  quarantineId: string;
  updatedAt: number;
}): SpxQuarantineResult {
  const { source, allSubscriptions, quarantineId, updatedAt } = input;
  if (source.kind !== 'local' || source.enabled !== true || !source.content) {
    throw ClientSafeProblemDetailsError.unprocessable(
      'spx 隔离仅允许作用于已启用且有内容的本地订阅源。',
    );
  }
  const parsed = parseProxyUriList(source.content);
  const spxFailures = parsed.errors.filter(
    (failure) =>
      failure.issue.scheme === 'vless' &&
      failure.issue.line !== null &&
      failure.error === 'unsupported vless Reality spiderX',
  );
  if (spxFailures.length === 0 || spxFailures.length !== parsed.errors.length) {
    throw ClientSafeProblemDetailsError.unprocessable(
      '订阅源除 spx 外还含其它解析错误，拒绝自动删除或猜测。',
    );
  }

  const quarantineLines = new Set(spxFailures.map((failure) => (failure.issue.line as number) - 1));
  const physicalLines = source.content.split('\n');
  const activeLines = physicalLines.filter((_line, index) => !quarantineLines.has(index));
  const isolatedLines = physicalLines.filter((_line, index) => quarantineLines.has(index));
  let activeContent = activeLines.join('\n');
  const quarantineContent = isolatedLines.join('\n');
  if (!quarantineContent.trim()) {
    throw ClientSafeProblemDetailsError.unprocessable('没有可保存到隔离源的 spx 原始行。');
  }
  const activeUriResult = parseProxyUriList(activeContent);
  if (activeUriResult.errors.length > 0) {
    throw ClientSafeProblemDetailsError.unprocessable(
      'spx 隔离后的订阅候选仍无法完整解析，拒绝写入。',
    );
  }
  if (activeUriResult.proxies.length === 0) activeContent = 'proxies: []\n';
  try {
    parseLocalProxies(activeContent);
  } catch {
    throw ClientSafeProblemDetailsError.unprocessable(
      'spx 隔离后的订阅候选仍无法完整解析，拒绝写入。',
    );
  }

  const quarantineName = `${source.name}-spx-quarantine`;
  if (allSubscriptions.some((subscription) => subscription.name === quarantineName)) {
    throw ClientSafeProblemDetailsError.conflict(
      `隔离订阅源「${quarantineName}」已存在，请先人工核对。`,
    );
  }
  if (allSubscriptions.some((subscription) => subscription.id === quarantineId)) {
    throw ClientSafeProblemDetailsError.conflict('隔离订阅源 id 已存在，请重新预览。');
  }

  const nextSource: Subscription = { ...source, content: activeContent, updated_at: updatedAt };
  const quarantine: Subscription = {
    id: quarantineId,
    name: quarantineName,
    display_name: `${source.display_name?.trim() || source.name}（spx 隔离）`,
    enabled: false,
    kind: 'local',
    content: quarantineContent,
    ttl_ms: source.ttl_ms,
    tags: ['quarantine', 'spx'],
    operators: [],
    updated_at: updatedAt,
  };
  return {
    source: nextSource,
    quarantine,
    summary: {
      sourceName: source.name,
      quarantineName,
      quarantinedNodes: isolatedLines.length,
    },
  };
}

export interface StaleChainRepairSpec {
  chainGroupId: string;
  frontPoolGroupId: string;
  consumerGroupId: string;
}

export interface StaleChainRepairSummary {
  chainGroupName: string;
  frontPoolGroupName: string;
  consumerGroupName: string;
  backendName: string;
}

export interface StaleChainGroupRepair {
  groupWrites: ProxyGroup[];
  groupDeletes: string[];
  backendName: string;
  summary: StaleChainRepairSummary;
}

function groupReferenceFields(group: ProxyGroup, targets: ReadonlySet<string>): string[] {
  const fields: string[] = [];
  if (group.proxies?.some((member) => targets.has(member))) fields.push('proxies');
  if (group['dialer-proxy'] && targets.has(group['dialer-proxy'])) fields.push('dialer-proxy');
  if (group['empty-fallback'] && targets.has(group['empty-fallback'])) {
    fields.push('empty-fallback');
  }
  return fields;
}

export function buildStaleChainGroupRepair(input: {
  groups: readonly ProxyGroup[];
  rules: readonly Rule[];
  spec: StaleChainRepairSpec;
  updatedAt: number;
}): StaleChainGroupRepair {
  const { groups, rules, spec, updatedAt } = input;
  const ids = [spec.chainGroupId, spec.frontPoolGroupId, spec.consumerGroupId];
  if (new Set(ids).size !== ids.length) {
    throw ClientSafeProblemDetailsError.badRequest('旧链、前置池和消费组必须是三个不同策略组。');
  }
  const byId = new Map(groups.map((group) => [group.id, group]));
  const chain = byId.get(spec.chainGroupId);
  const pool = byId.get(spec.frontPoolGroupId);
  const consumer = byId.get(spec.consumerGroupId);
  if (!chain || !pool || !consumer) {
    throw ClientSafeProblemDetailsError.notFound('找不到要移除的完整旧链策略组结构。');
  }
  if (
    chain['dialer-proxy'] !== pool.name ||
    !chain.proxies ||
    chain.proxies.length !== 1 ||
    !chain.proxies[0]
  ) {
    throw ClientSafeProblemDetailsError.unprocessable(
      '目标旧链不是“单后端 + 指定前置池”的窄范围结构，拒绝删除。',
    );
  }
  const chainRefs = consumer.proxies?.filter((member) => member === chain.name).length ?? 0;
  const nextMembers = consumer.proxies?.filter((member) => member !== chain.name) ?? [];
  if (chainRefs !== 1 || nextMembers.length === 0) {
    throw ClientSafeProblemDetailsError.unprocessable(
      '消费组必须且只能引用旧链一次，并且删除后仍需保留其它成员。',
    );
  }

  const targets = new Set([chain.name, pool.name]);
  for (const group of groups) {
    if (group.id === chain.id || group.id === pool.id) continue;
    const fields = groupReferenceFields(group, targets);
    if (group.id === consumer.id) {
      const unexpected = fields.filter((field) => field !== 'proxies');
      const poolMember = group.proxies?.includes(pool.name) ?? false;
      if (unexpected.length === 0 && !poolMember) continue;
    }
    if (fields.length > 0) {
      throw ClientSafeProblemDetailsError.unprocessable(
        '旧链或前置池仍被其它策略组引用，拒绝删除。',
      );
    }
  }
  if (rules.some((rule) => targets.has(rule.policy))) {
    throw ClientSafeProblemDetailsError.unprocessable('旧链或前置池仍被规则引用，拒绝删除。');
  }

  const nextConsumer: ProxyGroup = { ...consumer, proxies: nextMembers, updated_at: updatedAt };
  const backendName = chain.proxies[0];
  return {
    groupWrites: [nextConsumer],
    groupDeletes: [chain.id, pool.id],
    backendName,
    summary: {
      chainGroupName: chain.name,
      frontPoolGroupName: pool.name,
      consumerGroupName: consumer.name,
      backendName,
    },
  };
}

export interface LegacyChainProfileRepairInput {
  alias: string;
  repairs: ProxyGroupFilterRepair[];
  quarantineSpxSubscriptionId?: string;
  staleChain?: StaleChainRepairSpec;
}

export interface LegacyChainProfileRepairSummary {
  directMigration: DirectMigrationSummary;
  repairedFilterGroups: string[];
  spxQuarantine?: SpxQuarantineSummary;
  staleChain?: StaleChainRepairSummary;
}

export interface LegacyChainProfileRepairPlan {
  baseContent: string;
  baseMeta: ReturnType<typeof buildLegacyProfileRepairCandidate>['baseMeta'];
  groups: ProxyGroup[];
  groupDeletes: string[];
  rules: Rule[];
  subscriptions: Subscription[];
  expectedVersion: number;
  expectedBaseEtag: string;
  filterRepairBefore: ProxyGroup[];
  filterRepairAfter: ProxyGroup[];
  summary: LegacyChainProfileRepairSummary;
}

function mergeWrites<T extends { id: string }>(...sets: readonly T[][]): T[] {
  return [...new Map(sets.flat().map((value) => [value.id, value])).values()];
}

function applyWrites<T extends { id: string }>(
  current: readonly T[],
  writes: readonly T[],
  deletes: readonly string[] = [],
): T[] {
  const removed = new Set(deletes);
  const byId = new Map(writes.map((value) => [value.id, value]));
  const out: T[] = [];
  for (const value of current) {
    if (removed.has(value.id)) continue;
    out.push(byId.get(value.id) ?? value);
    byId.delete(value.id);
  }
  out.push(...byId.values());
  return out;
}

function profileUsesSubscription(
  profile: Profile,
  subscriptionId: string,
  subscriptions: readonly Subscription[],
  collections: Awaited<ReturnType<typeof loadDirectMigrationState>>['collections'],
): boolean {
  if (profile.source.type === 'subscription') return profile.source.id === subscriptionId;
  if (profile.source.type !== 'collection') return false;
  const collectionId = profile.source.id;
  const collection = collections.find((item) => item.id === collectionId);
  return collection
    ? resolveCollectionMemberSubs(collection, [...subscriptions]).some(
        (subscription) => subscription.id === subscriptionId,
      )
    : false;
}

async function validateRecoveryCandidate(input: {
  state: Awaited<ReturnType<typeof loadDirectMigrationState>>;
  baseContent: string;
  groups: ProxyGroup[];
  rules: Rule[];
  subscriptions: Subscription[];
}): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  const { state, baseContent, groups, rules, subscriptions } = input;
  const parsed = parseBase(baseContent);
  const validation = validateBase(
    parsed,
    rules,
    new Set(state.providers.map((provider) => provider.name)),
    groups.map((group) => group.name),
  );
  const blockViolations = [
    ...rulesBlockViolations(baseContent),
    ...ruleProvidersBlockViolations(baseContent),
  ];
  if (!validation.valid || blockViolations.length > 0) {
    throw ClientSafeProblemDetailsError.unprocessable('恢复候选会留下无效引用，已拒绝写入。', [
      ...validation.orphans,
      ...blockViolations,
    ]);
  }
  return resolveConfig(baseContent, rules, subscriptions, groups, state.templates, {
    providers: state.providers,
    collections: state.collections,
    boundSource: state.profile.source,
    ignoreFailedSubs: false,
    persistSnapshot: false,
    subscriptionResolver: resolveSubscriptionForPreflight,
  });
}

export async function planLegacyChainProfileRepair(
  profileId: string,
  input: LegacyChainProfileRepairInput,
  expectedVersion?: number,
  expectedBaseEtag?: string,
): Promise<LegacyChainProfileRepairPlan> {
  if (!input.quarantineSpxSubscriptionId && !input.staleChain) {
    throw ClientSafeProblemDetailsError.badRequest(
      '链式恢复必须包含 spx 隔离或旧链删除中的至少一项。',
    );
  }
  const state = await loadDirectMigrationState(profileId, expectedVersion);
  if (expectedBaseEtag !== undefined && state.base.etag !== expectedBaseEtag) {
    throw ClientSafeProblemDetailsError.conflict(
      'base.yaml 与恢复预览时的 ETag 不一致，请重新预览。',
    );
  }
  assertNoSharedProviderAlias(state, input.alias);
  const updatedAt = Math.floor(Date.now() / 1000);
  const candidate = buildLegacyProfileRepairCandidate({
    base: state.base,
    groups: state.groups,
    rules: state.rules,
    templates: state.templates,
    alias: input.alias,
    repairs: input.repairs,
    updatedAt,
  });

  let allGroups = applyWrites(state.groups, candidate.groups);
  const allRules = applyWrites(state.rules, candidate.rules);
  let allSubscriptions = state.subscriptions;
  let groupWrites = candidate.groups;
  let groupDeletes: string[] = [];
  let subscriptionWrites: Subscription[] = [];
  let spxQuarantine: SpxQuarantineSummary | undefined;
  let staleChain: StaleChainRepairSummary | undefined;
  let staleBackendName: string | undefined;

  if (input.quarantineSpxSubscriptionId) {
    const source = state.subscriptions.find(
      (subscription) => subscription.id === input.quarantineSpxSubscriptionId,
    );
    if (!source) throw ClientSafeProblemDetailsError.notFound('找不到要隔离 spx 的订阅源。');
    const profiles = await listProfiles();
    const consumers = profiles.filter((profile) =>
      profileUsesSubscription(profile, source.id, state.subscriptions, state.collections),
    );
    if (!consumers.some((profile) => profile.id === profileId)) {
      throw ClientSafeProblemDetailsError.unprocessable(
        '目标订阅源不属于当前 profile，拒绝跨 profile 修改。',
      );
    }
    if (consumers.length !== 1) {
      throw ClientSafeProblemDetailsError.unprocessable(
        '目标订阅源被多个 profile 共用；当前恢复工具只预检一个 profile，拒绝全局改写共享源。',
      );
    }
    const quarantine = buildSpxQuarantine({
      source,
      allSubscriptions: state.subscriptions,
      quarantineId: crypto.randomUUID(),
      updatedAt,
    });
    subscriptionWrites = [quarantine.source, quarantine.quarantine];
    allSubscriptions = applyWrites(state.subscriptions, subscriptionWrites);
    spxQuarantine = {
      ...quarantine.summary,
      affectedProfiles: consumers.map((profile) => profile.name),
    };
  }

  if (input.staleChain) {
    const removal = buildStaleChainGroupRepair({
      groups: allGroups,
      rules: allRules,
      spec: input.staleChain,
      updatedAt,
    });
    if (input.repairs.some((repair) => removal.groupDeletes.includes(repair.id))) {
      throw ClientSafeProblemDetailsError.badRequest('不能同时修复并删除同一个策略组。');
    }
    groupDeletes = removal.groupDeletes;
    allGroups = applyWrites(allGroups, removal.groupWrites, groupDeletes);
    groupWrites = mergeWrites(groupWrites, removal.groupWrites).filter(
      (group) => !groupDeletes.includes(group.id),
    );
    staleChain = removal.summary;
    staleBackendName = removal.backendName;
  }

  const rendered = await validateRecoveryCandidate({
    state,
    baseContent: candidate.baseContent,
    groups: allGroups,
    rules: allRules,
    subscriptions: allSubscriptions,
  });
  if (staleBackendName && rendered.nodeNames.includes(staleBackendName)) {
    throw ClientSafeProblemDetailsError.unprocessable(
      '目标链后端当前仍是有效具体节点，拒绝把有效链标记为陈旧并删除。',
    );
  }
  const afterValidation = await getConfigVersion();
  if (afterValidation !== state.version) {
    throw ClientSafeProblemDetailsError.conflict(
      `配置在恢复预览后发生了变化（预期版本 ${state.version}，当前版本 ${afterValidation}），请重新预览。`,
    );
  }

  return {
    baseContent: candidate.baseContent,
    baseMeta: {
      ...candidate.baseMeta,
      etag: computeEtag(candidate.baseContent),
    },
    groups: groupWrites,
    groupDeletes,
    rules: candidate.rules,
    subscriptions: subscriptionWrites,
    expectedVersion: state.version,
    expectedBaseEtag: state.base.etag,
    filterRepairBefore: candidate.filterRepairBefore,
    filterRepairAfter: candidate.filterRepairAfter,
    summary: {
      directMigration: {
        ...candidate.summary,
        expectedVersion: state.version,
        isolatedSubscriptionFailures: 0,
      },
      repairedFilterGroups: candidate.filterRepairAfter.map((group) => group.name),
      ...(spxQuarantine ? { spxQuarantine } : {}),
      ...(staleChain ? { staleChain } : {}),
    },
  };
}

export async function executeLegacyChainProfileRepair(
  profileId: string,
  input: LegacyChainProfileRepairInput,
  expectedVersion: number,
  expectedBaseEtag: string,
  actor: string,
): Promise<{ summary: LegacyChainProfileRepairSummary; newVersion: number; auditEventId: string }> {
  const plan = await planLegacyChainProfileRepair(
    profileId,
    input,
    expectedVersion,
    expectedBaseEtag,
  );
  const { newVersion, auditEventId } = await commitAtomicProfileRecovery(profileId, actor, plan, {
    op: 'legacy-chain-profile-repair.apply',
    target: { kind: 'profile' },
    before: {
      directAlias: plan.summary.directMigration.alias,
      repairedFilterGroups: plan.summary.repairedFilterGroups,
      ...(plan.summary.spxQuarantine
        ? {
            spxSource: plan.summary.spxQuarantine.sourceName,
            spxNodes: plan.summary.spxQuarantine.quarantinedNodes,
            affectedProfiles: plan.summary.spxQuarantine.affectedProfiles,
          }
        : {}),
      ...(plan.summary.staleChain
        ? {
            staleChain: plan.summary.staleChain.chainGroupName,
            staleFrontPool: plan.summary.staleChain.frontPoolGroupName,
          }
        : {}),
    },
    after: {
      directReplacement: 'DIRECT',
      ...(plan.summary.spxQuarantine
        ? { quarantineSource: plan.summary.spxQuarantine.quarantineName }
        : {}),
      ...(plan.summary.staleChain ? { staleChainRemoved: true } : {}),
    },
    undoable: false,
  });
  return { summary: plan.summary, newVersion, auditEventId };
}
