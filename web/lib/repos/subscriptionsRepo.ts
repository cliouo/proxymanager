import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { attachRawOperators, restoreRawOperators } from '@/lib/repos/rawOperators';
import {
  CAS_PIPELINE_ENTITY_WITH_ORDINALS,
  encodeOrdinalReservationPlan,
} from '@/lib/repos/ordinalReservationCas';
import { safeJsonClone, safeJsonStringify } from '@/lib/security/safeJson';
import type { OrdinalReservationPlan } from '@/lib/services/nodeOrdinalService';
import { SubscriptionSchema, type Subscription } from '@/schemas';

/**
 * Run stored rows through the Zod schema so defaults (kind, ttl_ms, tags)
 * are filled in for records persisted before the field existed. This is
 * the migration path — no separate one-shot script needed.
 */
function normalise(raw: unknown): Subscription | null {
  const parsed = SubscriptionSchema.safeParse(raw);
  if (!parsed.success) {
    // P3-10: a silently-dropped subscription looks like data loss to the user.
    const name = (raw as { name?: unknown })?.name;
    console.warn(
      `[subscriptionsRepo] skipping unparseable subscription${
        typeof name === 'string' ? ` "${name}"` : ''
      }: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
    return null;
  }
  // Raw persisted operators travel with the parsed record on a symbol: spreads
  // carry it, JSON never serializes it. Non-operator writes then restore the
  // raw bytes instead of persisting the parked decode (rawOperators.ts).
  const rawOperators = (raw as { operators?: unknown })?.operators;
  return rawOperators === undefined ? parsed.data : attachRawOperators(parsed.data, rawOperators);
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.subscriptions);
  if (!all) return [];
  const out: Subscription[] = [];
  for (const raw of Object.values(all)) {
    const sub = normalise(raw);
    if (sub) out.push(sub);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.subscriptions, id);
  return normalise(raw);
}

export async function getSubscriptionByName(name: string): Promise<Subscription | null> {
  const all = await listSubscriptions();
  return all.find((s) => s.name === name) ?? null;
}

// Writes bump config:version in the same multi() — subscription records
// (enabled/url/policy/operators…) shape the rendered config. P-FFP v1: the
// definition row is CONFIG-ONLY — runtime fetch state (last_synced_at /
// last_traffic / last_error / refresh receipts) was retired; the separate
// subscription-fetch-health value records actual attempt health instead.

export async function upsertSubscription(sub: Subscription): Promise<void> {
  // Non-operator writes must not destroy raw future-operator bytes.
  const toStore = restoreRawOperators(sub);
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.subscriptions, { [sub.id]: safeJsonClone(toStore) })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

/**
 * Atomically compare config:version, apply one subscription write and bump
 * the generation exactly once — the commit half of the node-processing save
 * gate. A subscription's operators shape every consuming profile's rendered
 * config, so the write must land under the same generation the preflight
 * validated; losing the race is a 412 + retry, not a silently different
 * persisted state.
 */
export const CAS_SUBSCRIPTION_CHANGE = CAS_PIPELINE_ENTITY_WITH_ORDINALS;

export interface SubscriptionCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

export async function commitSubscriptionChange(
  sub: Subscription,
  expectedVersion: number,
  ordinalPlan: OrdinalReservationPlan,
): Promise<SubscriptionCommitResult> {
  // Explicit operator saves replace the array (restoreRawOperators is a
  // no-op then); saves of OTHER render-affecting fields keep raw bytes.
  const toStore = restoreRawOperators(sub);
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const result = (await getRedis().eval(
    CAS_SUBSCRIPTION_CHANGE,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.subscriptions,
      REDIS_KEYS.namingHistory,
      REDIS_KEYS.nodeOrdinals,
      REDIS_KEYS.nodeOrdinalGeneration,
      ...encoded.counterKeys,
    ],
    [String(expectedVersion), toStore.id, safeJsonStringify(toStore), 'set', '', ...encoded.args],
  )) as [number, string];
  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}

/**
 * CAS delete for the save gate: compare config:version, HDEL the record, bump
 * exactly once. Deleting a shared source changes every consuming profile's
 * rendered output — the same preflight-then-commit discipline as writes.
 */
export const CAS_SUBSCRIPTION_DELETE = CAS_PIPELINE_ENTITY_WITH_ORDINALS;

export async function commitSubscriptionDelete(
  id: string,
  expectedVersion: number,
  ordinalPlan: OrdinalReservationPlan,
): Promise<SubscriptionCommitResult> {
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const result = (await getRedis().eval(
    CAS_SUBSCRIPTION_DELETE,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.subscriptions,
      REDIS_KEYS.namingHistory,
      REDIS_KEYS.nodeOrdinals,
      REDIS_KEYS.nodeOrdinalGeneration,
      ...encoded.counterKeys,
    ],
    [String(expectedVersion), id, '', 'delete', `subscription:${id}`, ...encoded.args],
  )) as [number, string];
  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.subscriptions, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
