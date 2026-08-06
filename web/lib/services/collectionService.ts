import { ProblemDetailsError } from '@/lib/http/problem';
import {
  applyOperatorMutation,
  buildOperatorSnapshot,
} from '@/lib/services/operatorMutationPolicy';
import {
  commitCollectionChange,
  commitCollectionDelete,
  getCollection,
  getCollectionByName,
  getCollectionBySlug,
  listCollections,
  upsertCollection,
} from '@/lib/repos/collectionsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import {
  commitUnderPipelineGate,
  consumingProfilesOfCollection,
} from '@/lib/services/nodePipelineSaveGate';
import {
  CollectionCreateSchema,
  CollectionUpdateSchema,
  type Collection,
  type CollectionCreate,
  type CollectionUpdate,
} from '@/schemas';

/**
 * Collection fields that change the rendered output of consuming profiles
 * (membership, group emission, node pipeline, labels). `notes` and `slug`
 * are cosmetic and stay ungated.
 */
const RENDER_AFFECTING_COLLECTION_FIELDS = new Set([
  'name',
  'enabled',
  'type',
  'subscription_ids',
  'subscription_tags',
  'operators',
]);

/** True when a PATCH touches at least one render-affecting field. */
function touchesRenderedOutput(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some((key) => RENDER_AFFECTING_COLLECTION_FIELDS.has(key));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Fire-and-forget snapshot invalidation. See subscriptionService for rationale. */
function invalidateSnapshot(): void {
  invalidateResolvedSnapshot().catch(() => undefined);
}

export async function createCollection(input: CollectionCreate): Promise<Collection> {
  const parsed = CollectionCreateSchema.parse(input);
  // pass-8 blocker 2: creating a rename-template row through a GENERIC
  // create is naming-row creation — the mutation policy's dedicated gate.
  let operators: unknown[] | undefined;
  if (parsed.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot({ operators: [] }),
      parsed.operators,
      'generic',
    ).storage;
  }
  // Version bracket FIRST — dup checks + commit share one generation.
  const planningVersion = await getConfigVersion();
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
    ...(operators !== undefined ? { operators: operators as Collection['operators'] } : {}),
    created_at: now,
    updated_at: now,
  };
  // A fresh collection id cannot be bound by any profile yet — no consumers —
  // but the insert still commits under the captured generation (CAS).
  const profiles = await listProfiles();
  await commitUnderPipelineGate({
    planningVersion,
    affected: consumingProfilesOfCollection(col.id, profiles),
    candidateCollections: (cols) => [...cols, col],
    commit: (version, ordinalGeneration) => commitCollectionChange(col, version, ordinalGeneration),
  });
  invalidateSnapshot();
  return col;
}

export async function patchCollection(
  id: string,
  patch: CollectionUpdate,
  expectedUpdatedAt?: number, // P2-2
): Promise<Collection> {
  const validated = CollectionUpdateSchema.parse(patch);
  // Version bracket FIRST — read/candidate/discovery/preflight/commit share
  // one generation; a concurrent write anywhere in between is a 412.
  const planningVersion = await getConfigVersion();
  const current = await getCollection(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Collection ${id} not found.`);
  }
  // pass-8 blocker 2: generic mutations may edit NON-name rows freely, but
  // every existing rename-template row must survive LOGICALLY unchanged and
  // never move across a surviving operator — creation/touch/delete/move of a
  // naming row fails the one bounded gate error before any write/audit. The
  // policy derives the exact raw storage list (untouched rows keep raw bytes
  // + unknown fields; key-order-only differences are equal).
  let operators: unknown[] | undefined;
  if (validated.operators !== undefined) {
    operators = applyOperatorMutation(
      buildOperatorSnapshot(current),
      validated.operators,
      'generic',
    ).storage;
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
  if (operators !== undefined) {
    (next as Record<string, unknown>).operators = operators;
  }
  // ANY definitional change (operators, membership, enabled, type, name)
  // changes every consuming profile's rendered output: preflight all
  // consumers against this exact candidate, then commit under the config
  // version the preflight saw (AGENTS.md shared-source invariant).
  if (touchesRenderedOutput(validated)) {
    const profiles = await listProfiles();
    await commitUnderPipelineGate({
      planningVersion,
      affected: consumingProfilesOfCollection(id, profiles),
      candidateCollections: (cols) => cols.map((c) => (c.id === id ? next : c)),
      commit: (version, ordinalGeneration) =>
        commitCollectionChange(next, version, ordinalGeneration),
    });
  } else {
    await upsertCollection(next);
  }
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
  // Version bracket FIRST — consumers are discovered and the delete lands
  // under the same generation.
  const planningVersion = await getConfigVersion();
  const col = await getCollection(id);
  const warnings: string[] = [];
  if (!col) {
    await commitUnderPipelineGate({
      planningVersion,
      affected: [],
      commit: (version, ordinalGeneration) =>
        commitCollectionDelete(id, version, ordinalGeneration),
    });
    return { removed: false, warnings };
  }
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
  await commitUnderPipelineGate({
    planningVersion,
    affected: consumingProfilesOfCollection(id, profiles),
    candidateCollections: (cols) => cols.filter((c) => c.id !== id),
    commit: (version, ordinalGeneration) => commitCollectionDelete(id, version, ordinalGeneration),
  });
  invalidateSnapshot();
  return { removed: true, warnings };
}

export { listCollections, getCollection, getCollectionByName, getCollectionBySlug };
