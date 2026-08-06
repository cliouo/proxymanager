/**
 * 节点处理（operators）保存闸口。
 *
 * 订阅源 / 聚合订阅的 operators 直接决定渲染产物 —— 每一份消费该来源的配置
 * 文件（连同其下的每一台设备）下一次渲染都会看到新名字 / 新节点集。沿用
 * AGENTS.md「Shared subscription mutation invariant」与 ruleSetGate 的先例：
 * **改写共享来源前，必须把每一个消费者都对着同一份候选、同一个配置版本预检
 * 过**，再在同一个 config:version 下 CAS 提交。消费者判定很廉价（profile
 * 绑定 + 聚合成员展开），全量预检才是贵的 —— 没有消费者时跳过预检，但仍走
 * CAS 提交，避免与并发的共享层写入交错。
 */

import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { preflightProfileConfig } from '@/lib/services/configPreflight';
import type { Collection, Profile, Subscription } from '@/schemas';

/**
 * Whether a collection includes the subscription — explicit id or tag match,
 * over the ENABLED authoritative member set (a disabled member's edit never
 * changes any render, so no preflight is needed — pass-10 blocker 1).
 */
export function collectionIncludesSubscription(
  collection: Collection,
  subscription: Subscription,
  allSubscriptions: Subscription[],
): boolean {
  if (collection.subscription_ids.includes(subscription.id)) return true;
  if (!subscription.tags.some((t) => collection.subscription_tags.includes(t))) return false;
  return enabledCollectionMemberSubs(collection, allSubscriptions).some(
    (s) => s.id === subscription.id,
  );
}

/** Profiles whose rendered config consumes a subscription's nodes. */
export function consumingProfilesOfSubscription(
  subscription: Subscription,
  collections: Collection[],
  allSubscriptions: Subscription[],
  profiles: Profile[],
): Profile[] {
  const memberCollections = new Set<string>();
  for (const col of collections) {
    if (collectionIncludesSubscription(col, subscription, allSubscriptions)) {
      memberCollections.add(col.id);
    }
  }
  return profiles.filter((p) =>
    p.source.type === 'subscription'
      ? p.source.id === subscription.id
      : p.source.type === 'collection' && memberCollections.has(p.source.id),
  );
}

/** Profiles whose rendered config consumes a collection's operator output. */
export function consumingProfilesOfCollection(
  collectionId: string,
  profiles: readonly Profile[],
): Profile[] {
  return profiles.filter((p) => p.source.type === 'collection' && p.source.id === collectionId);
}

export interface PipelineSavePlan {
  /**
   * The config version the caller captured BEFORE its initial entity read and
   * candidate construction. Every read (entity, consumers) and every preflight
   * must observe this same generation — a concurrent write at any point in the
   * read→candidate→discovery→commit chain then surfaces as a 412 instead of
   * committing a stale candidate. Optional for callers that only plan (no
   * commit half); save paths always pass it.
   */
  expectedVersion?: number;
  /** Consumers of the edited source. Empty = no preflight, CAS-only commit. */
  affected: readonly Profile[];
  /** Derive the candidate subscriptions list from the bracketed snapshot. */
  candidateSubscriptions?: (current: Subscription[]) => Subscription[];
  /** Derive the candidate collections list from the bracketed snapshot. */
  candidateCollections?: (current: Collection[]) => Collection[];
}

function assertSameGeneration(observed: number, expected: number | undefined): void {
  if (expected !== undefined && observed !== expected) {
    throw ProblemDetailsError.preconditionFailed(
      '配置在保存前校验期间被其他写入修改,请刷新后重试。',
    );
  }
}

/**
 * Preflight every consuming profile against the same candidate + version,
 * then return the version to commit under. Every observed generation must
 * equal `expectedVersion` when given (read→preflight→commit bracketing), and
 * all preflight generations must agree with each other. A 422 naming the
 * broken profile is thrown when a candidate fails validation.
 */
export async function preflightPipelineSave(plan: PipelineSavePlan): Promise<number> {
  if (plan.affected.length === 0) {
    // No consumers → the edit changes no rendered output, but the discovery
    // (empty) is only valid at the captured generation: an empty-to-nonempty
    // race must 412, not silently commit a consumer nobody preflighted.
    const version = await getConfigVersion();
    assertSameGeneration(version, plan.expectedVersion);
    return version;
  }

  let version: number | null = null;
  for (const profile of plan.affected) {
    const checked = await preflightProfileConfig(profile.id, (state) => ({
      ...(plan.candidateSubscriptions
        ? { subscriptions: plan.candidateSubscriptions(state.subscriptions) }
        : {}),
      ...(plan.candidateCollections
        ? { collections: plan.candidateCollections(state.collections) }
        : {}),
    })).catch((error: unknown) => {
      if (error instanceof Error && !(error instanceof ProblemDetailsError)) {
        error.message = `配置文件「${profile.name}」会被这次节点处理改动破坏：${error.message}`;
      }
      throw error;
    });

    assertSameGeneration(checked.configVersion, plan.expectedVersion);
    if (version === null) version = checked.configVersion;
    else if (version !== checked.configVersion) {
      throw ProblemDetailsError.preconditionFailed(
        '配置在保存前校验期间被其他写入修改,请刷新后重试。',
      );
    }
  }
  return version ?? (await getConfigVersion());
}

/**
 * Preflight + commit half of the save gate. Every mutation path that can
 * change rendered output funnels through here: capture the planning version
 * BEFORE the initial entity read, pass it in, and the commit only lands under
 * the exact generation the whole read→candidate→discovery→preflight chain
 * observed. Losing the race is a 412 + retry, never a stale commit.
 */
export async function commitUnderPipelineGate(options: {
  /** Config version captured before the first read of the edited entity. */
  planningVersion: number;
  affected: readonly Profile[];
  candidateSubscriptions?: (current: Subscription[]) => Subscription[];
  candidateCollections?: (current: Collection[]) => Collection[];
  commit: (version: number) => Promise<{ ok: boolean }>;
}): Promise<void> {
  const version = await preflightPipelineSave({
    expectedVersion: options.planningVersion,
    affected: options.affected,
    candidateSubscriptions: options.candidateSubscriptions,
    candidateCollections: options.candidateCollections,
  });
  const committed = await options.commit(version);
  if (!committed.ok) {
    throw ProblemDetailsError.preconditionFailed(
      '配置在保存前校验期间被其他写入修改,请刷新后重试。',
    );
  }
}
