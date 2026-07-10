import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteSubscription as repoDelete,
  getSubscription,
  getSubscriptionByName,
  listSubscriptions,
  upsertSubscription,
} from '@/lib/repos/subscriptionsRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import type {
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

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function generateSubscriptionId(): string {
  return crypto.randomUUID();
}

export async function createSubscription(input: SubscriptionCreate): Promise<Subscription> {
  const dup = await getSubscriptionByName(input.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`Subscription name "${input.name}" already exists.`);
  }
  const sub: Subscription = { ...input, id: generateSubscriptionId(), updated_at: nowSeconds() }; // P2-2
  await upsertSubscription(sub);
  invalidateSnapshot();
  return sub;
}

export async function replaceSubscription(
  id: string,
  input: SubscriptionCreate,
): Promise<Subscription> {
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
  const next: Subscription = {
    ...input,
    id,
    last_synced_at: current.last_synced_at,
    last_traffic: current.last_traffic,
    updated_at: nowSeconds(), // P2-2
  };
  await upsertSubscription(next);
  invalidateSnapshot();
  return next;
}

export async function patchSubscription(
  id: string,
  patch: SubscriptionUpdate,
  expectedUpdatedAt?: number, // P2-2
): Promise<Subscription> {
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
  const next: Subscription = { ...current, ...patch, updated_at: nowSeconds() }; // P2-2 bump version
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
  await upsertSubscription(next);
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
  const sub = await getSubscription(id);
  const warnings: string[] = [];
  if (sub) {
    const [profiles, collections] = await Promise.all([listProfiles(), listCollections()]);
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
  }
  const removed = await repoDelete(id);
  if (removed) invalidateSnapshot();
  return { removed, warnings };
}

export { listSubscriptions, getSubscription, getSubscriptionByName };
