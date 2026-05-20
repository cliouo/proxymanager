import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteSubscription as repoDelete,
  getSubscription,
  getSubscriptionByName,
  listSubscriptions,
  upsertSubscription,
} from '@/lib/repos/subscriptionsRepo';
import type {
  Subscription,
  SubscriptionCreate,
  SubscriptionTraffic,
  SubscriptionUpdate,
} from '@/schemas';

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
  const sub: Subscription = { ...input, id: generateSubscriptionId() };
  await upsertSubscription(sub);
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
  };
  await upsertSubscription(next);
  return next;
}

export async function patchSubscription(
  id: string,
  patch: SubscriptionUpdate,
): Promise<Subscription> {
  const current = await getSubscription(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  }
  if (patch.name && patch.name !== current.name) {
    const dup = await getSubscriptionByName(patch.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Subscription name "${patch.name}" already exists.`);
    }
  }
  const next: Subscription = { ...current, ...patch };
  await upsertSubscription(next);
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
  await upsertSubscription(next);
  return next;
}

export {
  listSubscriptions,
  getSubscription,
  getSubscriptionByName,
  repoDelete as deleteSubscription,
};
