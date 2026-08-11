import { createHash } from 'node:crypto';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  applyOperatorMutation,
  buildOperatorSnapshot,
} from '@/lib/services/operatorMutationPolicy';
import {
  commitSubscriptionChange,
  commitSubscriptionDelete,
  getSubscription,
  getSubscriptionByName,
  listSubscriptions,
  type SubscriptionManualSnapshotAction,
} from '@/lib/repos/subscriptionsRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import {
  commitUnderPipelineGate,
  consumingProfilesOfSubscription,
} from '@/lib/services/nodePipelineSaveGate';
import {
  computeSubscriptionDefinitionFingerprint,
  getSubscriptionFetchHealth,
  getSubscriptionFetchHealthMany,
  healthMatchesDefinition,
} from '@/lib/repos/subscriptionFetchHealthRepo';
import { parseSubscriptionManualSnapshotMeta } from '@/lib/repos/subscriptionManualSnapshotRepo';
import {
  buildCacheKey,
  FETCH_CACHE_STALE_RETENTION_MS,
  type FetchCacheEntry,
} from '@/lib/repos/fetchCacheRepo';
import {
  effectiveFetchFailurePolicy,
  effectiveFetchIdentityRevision,
  effectiveSubscriptionCustomHeaders,
  effectiveSubscriptionRefreshMode,
  MAX_SUBSCRIPTION_CONTENT,
  subscriptionUserAgent,
  type Profile,
  type Subscription,
  type SubscriptionAdminView,
  type SubscriptionCreate,
  type SubscriptionFetchHealth,
  type SubscriptionManualUpdateOrigin,
  type SubscriptionUpdate,
} from '@/schemas';
import {
  resolveSubscriptionContentRaw,
  validateManualSubscriptionContent,
} from '@/lib/services/subscriptionFetcher';
import { isActiveCurrentRenameTemplateOperator } from '@/schemas/operator';
import {
  describeSubscriptionContentIssue,
  SubscriptionResolutionValidationError,
} from '@/lib/services/subscriptionResolutionErrors';

function nextUpdatedAt(current: Pick<Subscription, 'updated_at'>): number {
  return Math.max(nowSeconds(), (current.updated_at ?? 0) + 1);
}

function canonicalFetchIdentity(subscription: Subscription): string {
  const customHeaders = effectiveSubscriptionCustomHeaders(subscription);
  return JSON.stringify({
    kind: subscription.kind,
    url: subscription.url,
    userAgent: subscriptionUserAgent(subscription),
    customHeaders,
  });
}

function applyFetchIdentityRevision(
  current: Subscription | null,
  candidate: Subscription,
): Subscription {
  if (candidate.kind === 'local') {
    delete candidate.fetch_identity_revision;
    return candidate;
  }
  if (!current || current.kind === 'local') {
    candidate.fetch_identity_revision = 1;
    return candidate;
  }
  if (canonicalFetchIdentity(current) !== canonicalFetchIdentity(candidate)) {
    candidate.fetch_identity_revision = effectiveFetchIdentityRevision(current) + 1;
  } else if (current.fetch_identity_revision === undefined) {
    delete candidate.fetch_identity_revision;
  } else {
    candidate.fetch_identity_revision = current.fetch_identity_revision;
  }
  return candidate;
}

function fetchHealthMustClear(current: Subscription | null, candidate: Subscription): boolean {
  if (current === null) return false;
  if (current.kind !== 'remote' || candidate.kind !== 'remote') return current !== null;
  if (effectiveSubscriptionRefreshMode(current) !== effectiveSubscriptionRefreshMode(candidate)) {
    return true;
  }
  return (
    computeSubscriptionDefinitionFingerprint(current) !==
    computeSubscriptionDefinitionFingerprint(candidate)
  );
}

/**
 * Subscription fields that change the rendered output of consuming profiles
 * (nodes, names, provenance aliases, membership, fallback policy). P-FFP v1:
 * the definition row is config-only — the retired runtime fields
 * (last_synced_at / last_traffic / last_error) are gone, so every non-empty
 * PATCH is declarative and preflights all consumers.
 */
const RENDER_AFFECTING_SUBSCRIPTION_FIELDS = new Set([
  'name',
  'display_name',
  'enabled',
  'kind',
  'url',
  'ua_override',
  'custom_headers',
  'ttl_ms',
  'content',
  'tags',
  'operators',
  'fetch_failure_policy',
  'refresh_mode',
]);

/** True when a PATCH touches at least one render-affecting field. */
function touchesRenderedOutput(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some((key) => RENDER_AFFECTING_SUBSCRIPTION_FIELDS.has(key));
}

/** 422: an explicit policy is remote-only — a resulting local source rejects it. */
function assertPolicyAllowedForKind(kind: Subscription['kind'], policy: unknown): void {
  if (kind === 'local' && policy !== undefined) {
    throw ProblemDetailsError.unprocessable(
      '本地订阅不支持 fetch_failure_policy（失败策略仅限远程订阅）。',
    );
  }
}

/** 422: refresh mode and imported snapshots are remote-source concepts. */
function assertRefreshModeAllowedForKind(kind: Subscription['kind'], refreshMode: unknown): void {
  if (kind === 'local' && refreshMode !== undefined) {
    throw ProblemDetailsError.unprocessable('本地订阅不支持 refresh_mode。');
  }
}

/**
 * Admin view projection (P-FFP v1): remote rows expose the EFFECTIVE policy
 * plus the fingerprint-matched health (or null); local rows omit both — even
 * when a legacy/corrupt local row somehow carries the fields, the projection
 * drops them (local responses must never consult or expose the policy).
 */
export function projectSubscriptionAdminView(
  subscription: Subscription,
  health?: SubscriptionFetchHealth | null,
): SubscriptionAdminView {
  const view = { ...subscription } as SubscriptionAdminView & Partial<Subscription>;
  delete view.fetch_identity_revision;
  delete view.manual_snapshot_meta;
  delete view.manual_snapshot;

  if (subscription.kind === 'local') {
    delete view.fetch_failure_policy;
    delete view.fetch_health;
    delete view.refresh_mode;
    return view;
  }
  delete view.content;

  const refreshMode = effectiveSubscriptionRefreshMode(subscription);
  const meta = parseSubscriptionManualSnapshotMeta(subscription);
  return {
    ...view,
    fetch_failure_policy: effectiveFetchFailurePolicy(subscription),
    fetch_health:
      refreshMode === 'server-auto' && healthMatchesDefinition(subscription, health)
        ? health
        : null,
    refresh_mode: refreshMode,
    manual_snapshot: meta
      ? {
          updated_at: meta.updated_at,
          proxy_count: meta.proxy_count,
          origin: meta.origin,
          source_changed:
            meta.fetch_identity_revision !== effectiveFetchIdentityRevision(subscription),
        }
      : null,
  };
}

/** Admin views for the whole library (one MGET for all remote healths). */
export async function listSubscriptionAdminViews(): Promise<SubscriptionAdminView[]> {
  const subs = await listSubscriptions();
  const remoteIds = subs
    .filter((s) => s.kind === 'remote' && effectiveSubscriptionRefreshMode(s) === 'server-auto')
    .map((s) => s.id);
  // Invariant 1: with NO remote sources the health store is never consulted —
  // not even with an empty key list.
  const healths = remoteIds.length === 0 ? [] : await getSubscriptionFetchHealthMany(remoteIds);
  const healthById = new Map(remoteIds.map((id, index) => [id, healths[index] ?? null]));
  return subs.map((sub) => projectSubscriptionAdminView(sub, healthById.get(sub.id)));
}

/** Admin view of one subscription (or null when unknown). */
export async function getSubscriptionAdminView(id: string): Promise<SubscriptionAdminView | null> {
  const sub = await getSubscription(id);
  if (!sub) return null;
  // P-FFP v1 invariant 1: LOCAL sources never consult health storage — the
  // health read happens only on the remote branch.
  if (sub.kind === 'local') return projectSubscriptionAdminView(sub);
  if (effectiveSubscriptionRefreshMode(sub) === 'manual') {
    return projectSubscriptionAdminView(sub);
  }
  return projectSubscriptionAdminView(sub, await getSubscriptionFetchHealth(id));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function generateSubscriptionId(): string {
  return crypto.randomUUID();
}

export async function createSubscription(input: SubscriptionCreate): Promise<Subscription> {
  assertPolicyAllowedForKind(input.kind, input.fetch_failure_policy);
  const planningVersion = await getConfigVersion();
  const dup = await getSubscriptionByName(input.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`Subscription name "${input.name}" already exists.`);
  }
  let operators: unknown[] | undefined;
  if (input.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot({ operators: [] }),
      input.operators,
      'generic',
    ).storage;
  }
  const sub = applyFetchIdentityRevision(null, {
    ...input,
    ...(operators !== undefined ? { operators: operators as Subscription['operators'] } : {}),
    ...(input.kind === 'remote' ? { refresh_mode: 'server-auto' as const } : {}),
    id: generateSubscriptionId(),
    updated_at: nowSeconds(),
  });
  if (sub.kind === 'remote') delete sub.content;
  const [collections, profiles, allSubs] = await Promise.all([
    listCollections(),
    listProfiles(),
    listSubscriptions(),
  ]);
  const candidateSubs = [...allSubs, sub];
  const affected = consumingProfilesOfSubscription(sub, collections, candidateSubs, profiles);
  await commitUnderPipelineGate({
    planningVersion,
    affected,
    candidateSubscriptions: (subs) => [...subs, sub],
    commit: (version, ordinalPlan) =>
      commitSubscriptionChange(sub, version, ordinalPlan, {
        manualSnapshot: sub.kind === 'local' ? { type: 'delete' } : { type: 'keep' },
      }),
  });
  return sub;
}

export async function replaceSubscription(
  id: string,
  input: SubscriptionCreate,
): Promise<Subscription> {
  assertPolicyAllowedForKind(input.kind, input.fetch_failure_policy);
  const planningVersion = await getConfigVersion();
  const current = await getSubscription(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  }
  if (input.name !== current.name) {
    const dup = await getSubscriptionByName(input.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Subscription name "${input.name}" already exists.`);
    }
  }
  let operators: unknown[] | undefined;
  if (input.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot(current),
      input.operators,
      'generic',
    ).storage;
  }
  const next = applyFetchIdentityRevision(current, {
    ...input,
    ...(operators !== undefined ? { operators: operators as Subscription['operators'] } : {}),
    ...(input.kind === 'remote'
      ? {
          refresh_mode:
            current.kind === 'remote'
              ? effectiveSubscriptionRefreshMode(current)
              : ('server-auto' as const),
          ...(current.kind === 'remote' && current.manual_snapshot_meta !== undefined
            ? { manual_snapshot_meta: current.manual_snapshot_meta }
            : {}),
        }
      : {}),
    id,
    updated_at: nextUpdatedAt(current),
  });
  if (next.kind === 'remote') delete next.content;
  const [collections, profiles, allSubs] = await Promise.all([
    listCollections(),
    listProfiles(),
    listSubscriptions(),
  ]);
  const currentConsumers = consumingProfilesOfSubscription(current, collections, allSubs, profiles);
  const nextSubs = allSubs.map((sub) => (sub.id === id ? next : sub));
  const candidateConsumers = consumingProfilesOfSubscription(next, collections, nextSubs, profiles);
  const byId = new Map<string, Profile>();
  for (const profile of [...currentConsumers, ...candidateConsumers]) {
    byId.set(profile.id, profile);
  }
  const manualSnapshot: SubscriptionManualSnapshotAction =
    next.kind === 'local' ? { type: 'delete' } : { type: 'keep' };
  await commitUnderPipelineGate({
    planningVersion,
    affected: [...byId.values()],
    candidateSubscriptions: (subs) => subs.map((sub) => (sub.id === id ? next : sub)),
    commit: (version, ordinalPlan) =>
      commitSubscriptionChange(next, version, ordinalPlan, {
        manualSnapshot,
        clearFetchHealth: fetchHealthMustClear(current, next),
      }),
  });
  return next;
}

export async function patchSubscription(
  id: string,
  patch: SubscriptionUpdate,
  expectedUpdatedAt?: number,
): Promise<Subscription> {
  const planningVersion = await getConfigVersion();
  const current = await getSubscription(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  }
  if (expectedUpdatedAt !== undefined && (current.updated_at ?? 0) !== expectedUpdatedAt) {
    throw ProblemDetailsError.preconditionFailed('该资源已被其他人修改,请刷新后重试。');
  }
  if (patch.name && patch.name !== current.name) {
    const dup = await getSubscriptionByName(patch.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Subscription name "${patch.name}" already exists.`);
    }
  }
  let operators: unknown[] | undefined;
  if (patch.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot(current),
      patch.operators,
      'generic',
    ).storage;
  }
  if (Object.keys(patch).length === 0) return current;

  let next: Subscription = {
    ...current,
    ...patch,
    ...(operators !== undefined ? { operators: operators as Subscription['operators'] } : {}),
    updated_at: nextUpdatedAt(current),
  };
  if (next.kind === 'local') {
    if (patch.fetch_failure_policy !== undefined) {
      throw ProblemDetailsError.unprocessable(
        '本地订阅不支持 fetch_failure_policy（失败策略仅限远程订阅）。',
      );
    }
    if (patch.refresh_mode !== undefined) {
      throw ProblemDetailsError.unprocessable('本地订阅不支持 refresh_mode。');
    }
    delete next.fetch_failure_policy;
    delete next.refresh_mode;
    delete next.manual_snapshot_meta;
  } else {
    delete next.content;
    if (current.kind === 'local' && next.refresh_mode === undefined) {
      next.refresh_mode = 'server-auto';
    }
  }
  assertPolicyAllowedForKind(next.kind, next.fetch_failure_policy);
  assertRefreshModeAllowedForKind(next.kind, next.refresh_mode);
  if (next.kind === 'remote' ? !next.url : !next.content) {
    throw ProblemDetailsError.unprocessable(
      next.kind === 'remote'
        ? '远程订阅需要 URL；本次修改会清空它。'
        : '本地订阅需要内容(content);本次修改会使其为空。',
    );
  }
  next = applyFetchIdentityRevision(current, next);

  let contentOverrides: ReadonlyMap<string, string> | undefined;
  let fetchCache:
    | { cacheKey: string; entry: FetchCacheEntry; ttlMs: number }
    | undefined;
  if (
    current.kind === 'remote' &&
    effectiveSubscriptionRefreshMode(current) === 'manual' &&
    next.kind === 'remote' &&
    effectiveSubscriptionRefreshMode(next) === 'server-auto'
  ) {
    if (!next.url) {
      throw ProblemDetailsError.unprocessable('远程订阅需要 URL。');
    }
    const fresh = await resolveSubscriptionContentRaw(next, {
      noCache: true,
      writeCache: false,
      recordHealth: false,
    });
    contentOverrides = new Map([[id, fresh.yaml]]);
    const customHeaders = effectiveSubscriptionCustomHeaders(next);
    fetchCache = {
      cacheKey: buildCacheKey({
        url: next.url,
        userAgent: subscriptionUserAgent(next),
        headers: customHeaders,
      }),
      entry: {
        content: fresh.yaml,
        ...(fresh.traffic ? { traffic: fresh.traffic } : {}),
        proxy_count: fresh.proxyCount,
        fetched_at: Date.now(),
      },
      ttlMs: Math.max(next.ttl_ms, FETCH_CACHE_STALE_RETENTION_MS),
    };
  }

  if (touchesRenderedOutput(patch)) {
    const [collections, profiles, allSubs] = await Promise.all([
      listCollections(),
      listProfiles(),
      listSubscriptions(),
    ]);
    const currentConsumers = consumingProfilesOfSubscription(
      current,
      collections,
      allSubs,
      profiles,
    );
    const nextSubs = allSubs.map((sub) => (sub.id === id ? next : sub));
    const candidateConsumers = consumingProfilesOfSubscription(
      next,
      collections,
      nextSubs,
      profiles,
    );
    const byId = new Map<string, Profile>();
    for (const profile of [...currentConsumers, ...candidateConsumers]) {
      byId.set(profile.id, profile);
    }
    const manualSnapshot: SubscriptionManualSnapshotAction =
      next.kind === 'local' ? { type: 'delete' } : { type: 'keep' };
    await commitUnderPipelineGate({
      planningVersion,
      affected: [...byId.values()],
      candidateSubscriptions: (subs) => subs.map((sub) => (sub.id === id ? next : sub)),
      contentOverrides,
      commit: (version, ordinalPlan) =>
        commitSubscriptionChange(next, version, ordinalPlan, {
          manualSnapshot,
          clearFetchHealth: fetchHealthMustClear(current, next),
          fetchCache,
        }),
    });
  }
  return next;
}

export interface ManualSubscriptionImportResult {
  proxyCount: number;
  updatedAt: number;
}

/** Validate, preflight and atomically activate one separately stored manual snapshot. */
export async function importManualSubscriptionContent(
  id: string,
  content: string,
  origin: SubscriptionManualUpdateOrigin,
  expectedUpdatedAt: number,
  expectedFetchIdentityRevision: number,
): Promise<ManualSubscriptionImportResult> {
  if (Buffer.byteLength(content, 'utf8') > MAX_SUBSCRIPTION_CONTENT) {
    throw ProblemDetailsError.payloadTooLarge('订阅内容过大，最大支持 4 MiB。');
  }

  const planningVersion = await getConfigVersion();
  const current = await getSubscription(id);
  if (!current) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  if (current.kind !== 'remote') {
    throw ProblemDetailsError.unprocessable('只有远程订阅可以导入手动更新内容。');
  }
  if (
    (current.updated_at ?? 0) !== expectedUpdatedAt ||
    effectiveFetchIdentityRevision(current) !== expectedFetchIdentityRevision
  ) {
    throw ProblemDetailsError.preconditionFailed('该资源已被其他人修改,请刷新后重试。');
  }

  const validated = (() => {
    try {
      return validateManualSubscriptionContent(
        content,
        (current.operators ?? []).some(isActiveCurrentRenameTemplateOperator),
      );
    } catch (error) {
      if (!(error instanceof SubscriptionResolutionValidationError)) throw error;
      if (error.contentIssue) {
        throw ProblemDetailsError.unprocessable(
          describeSubscriptionContentIssue(error.contentIssue),
        );
      }
      if (error.nodeIssue) {
        const { index, field, reason } = error.nodeIssue;
        throw ProblemDetailsError.unprocessable(
          `订阅内容包含无效节点：第 ${index + 1} 个节点的字段 "${field}" ${reason}。`,
        );
      }
      throw ProblemDetailsError.unprocessable('订阅内容无效。');
    }
  })();
  const importedAt = nextUpdatedAt(current);
  const next: Subscription = {
    ...current,
    refresh_mode: 'manual',
    manual_snapshot_meta: {
      updated_at: importedAt,
      proxy_count: validated.proxyCount,
      origin,
      fetch_identity_revision: effectiveFetchIdentityRevision(current),
      content_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    },
    updated_at: importedAt,
  };
  const contentOverrides = new Map<string, string>([[id, content]]);
  const [collections, profiles, allSubs] = await Promise.all([
    listCollections(),
    listProfiles(),
    listSubscriptions(),
  ]);
  const currentConsumers = consumingProfilesOfSubscription(current, collections, allSubs, profiles);
  const nextSubs = allSubs.map((sub) => (sub.id === id ? next : sub));
  const candidateConsumers = consumingProfilesOfSubscription(next, collections, nextSubs, profiles);
  const byId = new Map<string, Profile>();
  for (const profile of [...currentConsumers, ...candidateConsumers]) {
    byId.set(profile.id, profile);
  }

  await commitUnderPipelineGate({
    planningVersion,
    affected: [...byId.values()],
    candidateSubscriptions: (subs) => subs.map((sub) => (sub.id === id ? next : sub)),
    contentOverrides,
    commit: (version, ordinalPlan) =>
      commitSubscriptionChange(next, version, ordinalPlan, {
        manualSnapshot: { type: 'set', content },
        clearFetchHealth: fetchHealthMustClear(current, next),
      }),
  });

  return { proxyCount: validated.proxyCount, updatedAt: importedAt };
}

export interface DeleteSubscriptionResult {
  removed: boolean;
  /** Human-readable warnings about references left dangling by the deletion. */
  warnings: string[];
}

/**
 * Delete a subscription. Per P0-2 the decision is delete-but-warn (the render
 * pipeline already falls back to DIRECT so nothing becomes unloadable): before
 * removing, scan for profiles that bind this sub as their source and aggregate
 * subscriptions (聚合订阅) that list it as a member, and return those as
 * warnings so the route/UI can tell the user what just lost its node source.
 */
export async function deleteSubscription(id: string): Promise<DeleteSubscriptionResult> {
  // Version bracket FIRST: consumers are discovered at this generation and the
  // delete only lands under it (a membership race → 412, never an unvetted
  // removal).
  const planningVersion = await getConfigVersion();
  const sub = await getSubscription(id);
  const warnings: string[] = [];
  if (!sub) {
    await commitUnderPipelineGate({
      planningVersion,
      affected: [],
      commit: (version, ordinalGeneration) =>
        commitSubscriptionDelete(id, version, ordinalGeneration),
    });
    return { removed: false, warnings };
  }
  const [profiles, collections, allSubs] = await Promise.all([
    listProfiles(),
    listCollections(),
    listSubscriptions(),
  ]);
  const label = sub.display_name?.trim() || sub.name;
  const boundProfiles = profiles.filter(
    (p) => p.source?.type === 'subscription' && p.source.id === id,
  );
  const memberCols = collections.filter((c) => c.subscription_ids.includes(id));
  if (boundProfiles.length > 0) {
    warnings.push(
      `订阅源「${label}」被 ${boundProfiles.length} 个配置文件(${boundProfiles
        .map((p) => p.name)
        .join('、')})绑定为来源;删除后这些配置文件将没有可注入的节点(渲染兜底为 DIRECT)。`,
    );
  }
  if (memberCols.length > 0) {
    warnings.push(
      `订阅源「${label}」是 ${memberCols.length} 个聚合订阅(${memberCols
        .map((c) => c.name)
        .join('、')})的成员;删除后会从这些聚合中移除。`,
    );
  }
  const affected = consumingProfilesOfSubscription(sub, collections, allSubs, profiles);
  await commitUnderPipelineGate({
    planningVersion,
    affected,
    candidateSubscriptions: (subs) => subs.filter((s) => s.id !== id),
    commit: (version, ordinalGeneration) =>
      commitSubscriptionDelete(id, version, ordinalGeneration),
  });
  return { removed: true, warnings };
}

export { listSubscriptions, getSubscription, getSubscriptionByName };
