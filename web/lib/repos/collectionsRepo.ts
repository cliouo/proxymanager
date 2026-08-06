import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { attachRawOperators, restoreRawOperators } from '@/lib/repos/rawOperators';
import {
  CAS_PIPELINE_ENTITY_WITH_ORDINALS,
  encodeOrdinalReservationPlan,
} from '@/lib/repos/ordinalReservationCas';
import { safeJsonClone, safeJsonStringify } from '@/lib/security/safeJson';
import type { OrdinalReservationPlan } from '@/lib/services/nodeOrdinalService';
import { CollectionSchema, type Collection } from '@/schemas';

function normalise(raw: unknown): Collection | null {
  const parsed = CollectionSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Same raw-operator preservation contract as subscriptionsRepo.
  const rawOperators = (raw as { operators?: unknown })?.operators;
  return rawOperators === undefined ? parsed.data : attachRawOperators(parsed.data, rawOperators);
}

export async function listCollections(): Promise<Collection[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.collections);
  if (!all) return [];
  const out: Collection[] = [];
  for (const raw of Object.values(all)) {
    const c = normalise(raw);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCollection(id: string): Promise<Collection | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.collections, id);
  return normalise(raw);
}

export async function getCollectionByName(name: string): Promise<Collection | null> {
  const all = await listCollections();
  return all.find((c) => c.name === name) ?? null;
}

export async function getCollectionBySlug(slug: string): Promise<Collection | null> {
  const all = await listCollections();
  return all.find((c) => c.slug === slug) ?? null;
}

// Writes bump config:version in the same multi() — collections drive
// collection-scope proxy-groups and profile bindings in the rendered config.

export async function upsertCollection(col: Collection): Promise<void> {
  // Cosmetic patches (notes etc.) must not destroy raw future-operator bytes.
  const toStore = restoreRawOperators(col);
  await getRedis()
    .multi()
    .hset(REDIS_KEYS.collections, { [col.id]: safeJsonClone(toStore) })
    .incr(REDIS_KEYS.configVersion)
    .exec();
}

/**
 * Atomically compare config:version, apply one collection write and bump the
 * generation exactly once — the commit half of the node-processing save gate
 * (same rationale as commitSubscriptionChange).
 */
export const CAS_COLLECTION_CHANGE = CAS_PIPELINE_ENTITY_WITH_ORDINALS;

export interface CollectionCommitResult {
  ok: boolean;
  currentVersion: number | null;
}

export async function commitCollectionChange(
  col: Collection,
  expectedVersion: number,
  ordinalPlan: OrdinalReservationPlan,
): Promise<CollectionCommitResult> {
  const toStore = restoreRawOperators(col);
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const result = (await getRedis().eval(
    CAS_COLLECTION_CHANGE,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.collections,
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
 * exactly once (same preflight-then-commit discipline as writes).
 */
export const CAS_COLLECTION_DELETE = CAS_PIPELINE_ENTITY_WITH_ORDINALS;

export async function commitCollectionDelete(
  id: string,
  expectedVersion: number,
  ordinalPlan: OrdinalReservationPlan,
): Promise<CollectionCommitResult> {
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const result = (await getRedis().eval(
    CAS_COLLECTION_DELETE,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.collections,
      REDIS_KEYS.namingHistory,
      REDIS_KEYS.nodeOrdinals,
      REDIS_KEYS.nodeOrdinalGeneration,
      ...encoded.counterKeys,
    ],
    [String(expectedVersion), id, '', 'delete', `collection:${id}`, ...encoded.args],
  )) as [number, string];
  const parsedVersion = Number(Array.isArray(result) ? result[1] : '');
  return {
    ok: Array.isArray(result) && result[0] === 1,
    currentVersion:
      Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null,
  };
}

export async function deleteCollection(id: string): Promise<boolean> {
  const [removed] = await getRedis()
    .multi()
    .hdel(REDIS_KEYS.collections, id)
    .incr(REDIS_KEYS.configVersion)
    .exec<[number, number]>();
  return removed > 0;
}
