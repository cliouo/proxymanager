import { ProblemDetailsError } from '@/lib/http/problem';
import {
  applyOperatorMutation,
  buildOperatorSnapshot,
} from '@/lib/services/operatorMutationPolicy';
import {
  commitSubscriptionChange,
  commitSubscriptionDelete,
  deleteSubscription as repoDelete,
  getSubscription,
  getSubscriptionByName,
  listSubscriptions,
  upsertSubscription,
} from '@/lib/repos/subscriptionsRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import {
  commitUnderPipelineGate,
  consumingProfilesOfSubscription,
} from '@/lib/services/nodePipelineSaveGate';
import type {
  Profile,
  Subscription,
  SubscriptionCreate,
  SubscriptionTraffic,
  SubscriptionUpdate,
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
 * (nodes, names, provenance aliases, membership). Runtime-only fields set by
 * the refresh paths (last_synced_at / last_traffic / last_error) are written
 * via their own record* helpers and never appear here.
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
]);

/** True when a PATCH touches at least one render-affecting field. */
function touchesRenderedOutput(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some((key) => RENDER_AFFECTING_SUBSCRIPTION_FIELDS.has(key));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function generateSubscriptionId(): string {
  return crypto.randomUUID();
}

export async function createSubscription(input: SubscriptionCreate): Promise<Subscription> {
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
    commit: (version) => commitSubscriptionChange(sub, version),
  });
  invalidateSnapshot();
  return sub;
}

export async function replaceSubscription(
  id: string,
  input: SubscriptionCreate,
): Promise<Subscription> {
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
    last_synced_at: current.last_synced_at,
    last_traffic: current.last_traffic,
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
    commit: (version) => commitSubscriptionChange(next, version),
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
  const next: Subscription = {
    ...current,
    ...patch,
    ...(operators !== undefined ? { operators: operators as Subscription['operators'] } : {}),
    updated_at: nowSeconds(),
  }; // P2-2 bump version
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
  // ANY definitional change (operators, url/content, display_name/name which
  // feeds the rename-template source alias, enabled, tags…) changes every
  // consuming profile's rendered output: preflight all consumers against this
  // exact candidate, then commit under the config version the preflight saw
  // (AGENTS.md shared-source invariant).
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
      commit: (version) => commitSubscriptionChange(next, version),
    });
  } else {
    await upsertSubscription(next);
  }
  invalidateSnapshot();
  return next;
}

export async function recordSubscriptionSync(
  id: string,
  syncedAt: number,
  traffic?: SubscriptionTraffic,
): Promise<Subscription> {
  const current = await getSubscription(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  }
  const next: Subscription = {
    ...current,
    last_synced_at: syncedAt,
    last_traffic: traffic ?? current.last_traffic,
  };
  // P3-8: a successful sync clears any prior error so the status badge recovers.
  delete (next as { last_error?: string }).last_error;
  await upsertSubscription(next);
  invalidateSnapshot();
  return next;
}

/**
 * P3-8: persist the reason a refresh failed so the UI status badge can show it
 * (the `last_error` field existed but was never written). Best-effort — never
 * let recording the error mask the original failure.
 */
export async function recordSubscriptionError(id: string, message: string): Promise<void> {
  const current = await getSubscription(id);
  if (!current) return;
  const next: Subscription = { ...current, last_error: message.slice(0, 500) };
  await upsertSubscription(next);
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
    const removed = await repoDelete(id);
    return { removed, warnings };
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
    commit: (version) => commitSubscriptionDelete(id, version),
  });
  invalidateSnapshot();
  return { removed: true, warnings };
}

export { listSubscriptions, getSubscription, getSubscriptionByName };
