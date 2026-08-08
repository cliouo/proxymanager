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
} from '@/lib/repos/subscriptionsRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import {
  commitUnderPipelineGate,
  consumingProfilesOfSubscription,
} from '@/lib/services/nodePipelineSaveGate';
import {
  deleteSubscriptionFetchHealth,
  getSubscriptionFetchHealth,
  getSubscriptionFetchHealthMany,
  healthMatchesDefinition,
} from '@/lib/repos/subscriptionFetchHealthRepo';
import {
  effectiveFetchFailurePolicy,
  type Profile,
  type Subscription,
  type SubscriptionAdminView,
  type SubscriptionCreate,
  type SubscriptionFetchHealth,
  type SubscriptionUpdate,
} from '@/schemas';

/**
 * Fire-and-forget snapshot invalidation. Snapshot reads have a long Redis
 * EX as a safety net, so a missed invalidation is bounded; never let a
 * Redis hiccup here turn a successful mutation into a 500.
 */
function invalidateSnapshot(): void {
  invalidateResolvedSnapshot().catch(() => undefined);
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
  if (subscription.kind === 'local') {
    const view: SubscriptionAdminView = { ...subscription };
    delete view.fetch_failure_policy;
    delete view.fetch_health;
    return view;
  }
  return {
    ...subscription,
    fetch_failure_policy: effectiveFetchFailurePolicy(subscription),
    fetch_health: healthMatchesDefinition(subscription, health) ? health : null,
  };
}

/** Admin views for the whole library (one MGET for all remote healths). */
export async function listSubscriptionAdminViews(): Promise<SubscriptionAdminView[]> {
  const subs = await listSubscriptions();
  const remoteIds = subs.filter((s) => s.kind === 'remote').map((s) => s.id);
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
  return projectSubscriptionAdminView(sub, await getSubscriptionFetchHealth(id));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function generateSubscriptionId(): string {
  return crypto.randomUUID();
}

export async function createSubscription(input: SubscriptionCreate): Promise<Subscription> {
  // P-FFP v1: the policy is remote-only — an explicit value on a local create
  // is rejected before any read/write.
  assertPolicyAllowedForKind(input.kind, input.fetch_failure_policy);
  // Version bracket FIRST: every read below (dup check, consumer discovery)
  // must belong to the generation the commit will land on.
  const planningVersion = await getConfigVersion();
  const dup = await getSubscriptionByName(input.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`Subscription name "${input.name}" already exists.`);
  }
  // pass-8 blocker 2: creating a rename-template row through a GENERIC
  // create is naming-row creation — the dedicated gate error (the mutation
  // policy owns the invariant; a fresh record has no raw rows).
  let operators: unknown[] | undefined;
  if (input.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot({ operators: [] }),
      input.operators,
      'generic',
    ).storage;
  }
  const sub: Subscription = {
    ...input,
    ...(operators !== undefined ? { operators: operators as Subscription['operators'] } : {}),
    id: generateSubscriptionId(),
    updated_at: nowSeconds(),
  }; // P2-2
  // A brand-new sub can already match tag-based collections that profiles are
  // bound to — those consumers must be preflighted before the insert. Tag
  // membership is resolved against the CANDIDATE universe (allSubs + the new
  // sub), never the pre-insert list, or the new source commits without its
  // newly-matching consumer ever being preflighted.
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
    commit: (version, ordinalGeneration) =>
      commitSubscriptionChange(sub, version, ordinalGeneration),
  });
  invalidateSnapshot();
  return sub;
}

export async function replaceSubscription(
  id: string,
  input: SubscriptionCreate,
): Promise<Subscription> {
  // P-FFP v1: the policy is remote-only — an explicit value on a local
  // candidate is rejected before any read/write.
  assertPolicyAllowedForKind(input.kind, input.fetch_failure_policy);
  // Version bracket FIRST — the entity read + candidate must belong to the
  // generation the commit lands on.
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
  // pass-10 blocker 2: generic PUT/replace is a NAMING-ROW mutation surface —
  // the mutation policy runs the shared current-vs-candidate invariant
  // before any write/audit and derives the exact raw storage list (untouched
  // rows — including the naming row — survive byte-for-byte with their
  // unknown fields; key-order-only differences are semantically equal).
  let operators: unknown[] | undefined;
  if (input.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot(current),
      input.operators,
      'generic',
    ).storage;
  }
  const next: Subscription = {
    ...input,
    ...(operators !== undefined ? { operators: operators as Subscription['operators'] } : {}),
    id,
    updated_at: nowSeconds(), // P2-2
  };
  // Full replacement changes every consuming profile's rendered output:
  // preflight the union of current + candidate consumers, CAS commit.
  const [collections, profiles, allSubs] = await Promise.all([
    listCollections(),
    listProfiles(),
    listSubscriptions(),
  ]);
  const currentConsumers = consumingProfilesOfSubscription(current, collections, allSubs, profiles);
  const nextSubs = allSubs.map((sub) => (sub.id === id ? next : sub));
  const candidateConsumers = consumingProfilesOfSubscription(next, collections, nextSubs, profiles);
  const byId = new Map<string, Profile>();
  for (const p of [...currentConsumers, ...candidateConsumers]) byId.set(p.id, p);
  await commitUnderPipelineGate({
    planningVersion,
    affected: [...byId.values()],
    candidateSubscriptions: (subs) => subs.map((sub) => (sub.id === id ? next : sub)),
    commit: (version, ordinalGeneration) =>
      commitSubscriptionChange(next, version, ordinalGeneration),
  });
  invalidateSnapshot();
  return next;
}

export async function patchSubscription(
  id: string,
  patch: SubscriptionUpdate,
  expectedUpdatedAt?: number, // P2-2
): Promise<Subscription> {
  // Version bracket FIRST: the entity read, candidate construction, consumer
  // discovery and preflight must all observe the generation the commit lands
  // on — any concurrent write in between is a 412, never a stale commit.
  const planningVersion = await getConfigVersion();
  const current = await getSubscription(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  }
  // P2-2: optimistic concurrency. When the caller passes their last-known
  // updated_at (via If-Match), refuse if the record moved since — otherwise two
  // concurrent editors (two tabs / human + AI) silently overwrite each other.
  if (expectedUpdatedAt !== undefined && current.updated_at !== expectedUpdatedAt) {
    throw ProblemDetailsError.preconditionFailed('该资源已被其他人修改,请刷新后重试。');
  }
  if (patch.name && patch.name !== current.name) {
    const dup = await getSubscriptionByName(patch.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Subscription name "${patch.name}" already exists.`);
    }
  }
  // pass-8 blocker 2: generic mutations may edit NON-name rows freely, but
  // every existing rename-template row must survive LOGICALLY unchanged
  // (key-order-insensitive) and never move across a surviving operator —
  // creation/touch/delete/move of a naming row fails the one bounded gate
  // error before any write/audit. The profile-bound naming apply service is
  // the ONLY rename-template mutation path. The policy also derives the
  // exact raw storage list: untouched rows (naming row included) keep their
  // raw bytes + unknown fields; edited same-kind rows merge known fields
  // while retaining unknown ones.
  let operators: unknown[] | undefined;
  if (patch.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot(current),
      patch.operators,
      'generic',
    ).storage;
  }
  // An empty PATCH is a no-op: no write, no version bump, current row returned.
  if (Object.keys(patch).length === 0) return current;

  // P-FFP v1 policy merge semantics:
  //   - explicit policy on a resulting LOCAL source → 422 before preflight/write;
  //   - remote→local WITHOUT an explicit policy → the inherited policy is
  //     removed from the candidate (local never stores/consults it);
  //   - local→remote without a policy → effective default applies (nothing stored).
  const next: Subscription = {
    ...current,
    ...patch,
    ...(operators !== undefined ? { operators: operators as Subscription['operators'] } : {}),
    updated_at: nowSeconds(),
  }; // P2-2 bump version
  if (next.kind === 'local') {
    // Order matters: an EXPLICIT policy on a resulting local source must 422
    // before the inherited-policy removal can swallow it.
    if (patch.fetch_failure_policy !== undefined) {
      throw ProblemDetailsError.unprocessable(
        '本地订阅不支持 fetch_failure_policy（失败策略仅限远程订阅）。',
      );
    }
    delete next.fetch_failure_policy;
  }
  assertPolicyAllowedForKind(next.kind, next.fetch_failure_policy);
  // P3-7: the create path pins the kind/url/content combo (remote needs url,
  // local needs content), but PATCH merges field-by-field and could break it —
  // e.g. switch kind→local without content, or clear the url of a remote sub.
  // Re-check the merged record before persisting.
  if (next.kind === 'remote' ? !next.url : !next.content) {
    throw ProblemDetailsError.unprocessable(
      next.kind === 'remote'
        ? '远程订阅需要 URL；本次修改会清空它。'
        : '本地订阅需要内容(content);本次修改会使其为空。',
    );
  }
  // EVERY non-empty valid PATCH is declarative and changes every consuming
  // profile's rendered output (the runtime row patch was retired): preflight
  // all consumers against this exact candidate, then commit under the config
  // version the preflight saw (AGENTS.md shared-source invariant).
  if (touchesRenderedOutput(patch)) {
    const [collections, profiles, allSubs] = await Promise.all([
      listCollections(),
      listProfiles(),
      listSubscriptions(),
    ]);
    // Consumers are the UNION of current-membership consumers and
    // candidate-membership consumers: a tags patch can make this sub newly
    // match a tag-based collection that a profile is bound to — that profile
    // must be preflighted even though it consumes nothing today.
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
    for (const p of [...currentConsumers, ...candidateConsumers]) byId.set(p.id, p);
    await commitUnderPipelineGate({
      planningVersion,
      affected: [...byId.values()],
      candidateSubscriptions: (subs) => subs.map((sub) => (sub.id === id ? next : sub)),
      commit: (version, ordinalGeneration) =>
        commitSubscriptionChange(next, version, ordinalGeneration),
    });
  }
  invalidateSnapshot();
  return next;
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
    // P-FFP v1: after the definition CAS, best-effort drop the separate
    // fetch-health value (idempotent when the row was already gone).
    await deleteSubscriptionFetchHealth(id);
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
  // P-FFP v1: after the definition CAS, best-effort drop the separate
  // fetch-health value — a health hiccup never turns a delete into a 500.
  await deleteSubscriptionFetchHealth(id);
  invalidateSnapshot();
  return { removed: true, warnings };
}

export { listSubscriptions, getSubscription, getSubscriptionByName };
