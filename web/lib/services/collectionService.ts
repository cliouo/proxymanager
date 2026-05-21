import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteCollection as repoDelete,
  getCollection,
  getCollectionByName,
  listCollections,
  upsertCollection,
} from '@/lib/repos/collectionsRepo';
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
  return next;
}

export { listCollections, getCollection, getCollectionByName, repoDelete as deleteCollection };
