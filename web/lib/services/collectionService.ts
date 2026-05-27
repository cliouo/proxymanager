import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteCollection as repoDelete,
  getCollection,
  getCollectionByName,
  listCollections,
  upsertCollection,
} from '@/lib/repos/collectionsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import {
  CollectionCreateSchema,
  CollectionUpdateSchema,
  type Collection,
  type CollectionCreate,
  type CollectionUpdate,
} from '@/schemas';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Fire-and-forget snapshot invalidation. See subscriptionService for rationale. */
function invalidateSnapshot(): void {
  invalidateResolvedSnapshot().catch(() => undefined);
}

export async function createCollection(input: CollectionCreate): Promise<Collection> {
  const parsed = CollectionCreateSchema.parse(input);
  const dup = await getCollectionByName(parsed.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`Collection name "${parsed.name}" already exists.`);
  }
  const now = nowSeconds();
  const col: Collection = {
    id: crypto.randomUUID(),
    ...parsed,
    created_at: now,
    updated_at: now,
  };
  await upsertCollection(col);
  invalidateSnapshot();
  return col;
}

export async function patchCollection(
  id: string,
  patch: CollectionUpdate,
): Promise<Collection> {
  const validated = CollectionUpdateSchema.parse(patch);
  const current = await getCollection(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Collection ${id} not found.`);
  }
  if (validated.name && validated.name !== current.name) {
    const dup = await getCollectionByName(validated.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(
        `Collection name "${validated.name}" already exists.`,
      );
    }
  }
  const next: Collection = {
    ...current,
    ...validated,
    updated_at: nowSeconds(),
  };
  await upsertCollection(next);
  invalidateSnapshot();
  return next;
}

export async function deleteCollection(id: string): Promise<boolean> {
  const removed = await repoDelete(id);
  if (removed) invalidateSnapshot();
  return removed;
}

export { listCollections, getCollection, getCollectionByName };
