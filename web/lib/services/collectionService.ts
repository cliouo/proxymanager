import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteCollection as repoDelete,
  getCollection,
  getCollectionByName,
  getCollectionBySlug,
  listCollections,
  upsertCollection,
} from '@/lib/repos/collectionsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
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
  const slugDup = await getCollectionBySlug(parsed.slug);
  if (slugDup) {
    throw ProblemDetailsError.conflict(`Collection slug "${parsed.slug}" already exists.`);
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
  expectedUpdatedAt?: number, // P2-2
): Promise<Collection> {
  const validated = CollectionUpdateSchema.parse(patch);
  const current = await getCollection(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Collection ${id} not found.`);
  }
  // P2-2: optimistic concurrency guard — refuse a stale write (see
  // subscriptionService/ruleSetService for rationale).
  if (expectedUpdatedAt !== undefined && current.updated_at !== expectedUpdatedAt) {
    throw ProblemDetailsError.preconditionFailed('该资源已被其他人修改,请刷新后重试。');
  }
  if (validated.name && validated.name !== current.name) {
    const dup = await getCollectionByName(validated.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Collection name "${validated.name}" already exists.`);
    }
  }
  // P1-5: null clears a field (delete the key); undefined leaves it unchanged.
  const next: Collection = { ...current, updated_at: nowSeconds() };
  for (const [k, v] of Object.entries(validated)) {
    if (v === null) {
      delete (next as Record<string, unknown>)[k];
    } else if (v !== undefined) {
      (next as Record<string, unknown>)[k] = v;
    }
  }
  await upsertCollection(next);
  invalidateSnapshot();
  return next;
}

export interface DeleteCollectionResult {
  removed: boolean;
  warnings: string[];
}

/**
 * Delete an aggregate subscription (聚合订阅). P0-2 decision: delete-but-warn.
 * Scan for profiles that bind this collection as their source first so the
 * route/UI can tell the user those profiles will lose their node source
 * (render falls back to DIRECT, so nothing becomes unloadable).
 */
export async function deleteCollection(id: string): Promise<DeleteCollectionResult> {
  const col = await getCollection(id);
  const warnings: string[] = [];
  if (col) {
    const profiles = await listProfiles();
    const boundProfiles = profiles.filter(
      (p) => p.source?.type === 'collection' && p.source.id === id,
    );
    if (boundProfiles.length > 0) {
      warnings.push(
        `聚合订阅「${col.name}」被 ${boundProfiles.length} 个配置文件(${boundProfiles
          .map((p) => p.name)
          .join('、')})绑定为来源;删除后这些配置文件将没有可注入的节点(渲染兜底为 DIRECT)。`,
      );
    }
  }
  const removed = await repoDelete(id);
  if (removed) invalidateSnapshot();
  return { removed, warnings };
}

export { listCollections, getCollection, getCollectionByName, getCollectionBySlug };
