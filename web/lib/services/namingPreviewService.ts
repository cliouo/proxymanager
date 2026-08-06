/**
 * namingPreviewService — the shared zero-write naming preview path.
 *
 * Workspace UI preview, assistant confirmation preview and the generic
 * preview routes all derive their managed candidate from the SAME builder
 * (namingManagedCandidate) and run the SAME zero-write pipeline preview
 * functions (pipelinePreview.ts). Preview never saves: no fetch-cache
 * writes, no ordinal persistence, no CAS, no audit.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { withRawIdentity } from '@/lib/proxies/naming';
import { resolveOrdinalsFor } from '@/lib/services/nodeOrdinalService';
import { sourceOf } from '@/lib/proxies/provenance';
import { buildOperatorSnapshot } from '@/lib/repos/rawOperators';
import { StoredOperatorListSchema } from '@/schemas/operator';
import {
  buildManagedCandidate,
  type NamingManagedPlan,
} from '@/lib/services/namingManagedCandidate';
import {
  buildPreviewIssues,
  dedupMachineIssues,
  namesPayload,
  projectStepsSourceKeys,
  type NamesPayload,
  type PreviewIssue,
} from '@/lib/services/pipelinePreview';
import { dedupExportProxies, mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import { getSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { getCollection } from '@/lib/services/collectionService';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import type { Operator, StoredOperator } from '@/schemas';

export interface NamingPreviewResult {
  after: NamesPayload;
  issues: PreviewIssue[];
  candidate: { id: string; index: number; mode: 'added' | 'replaced' | 'kept' };
}

export interface NamingPreviewInput extends NamingManagedPlan {
  position?: number;
}

/**
 * Build the managed candidate for an entity record WITHOUT writing anything
 * (pure: snapshot + builder). Exposed so the assistant preview path and the
 * workspace route share one derivation.
 */
export function namingCandidateForEntity<T extends { operators?: unknown }>(
  entity: T,
  input: NamingPreviewInput,
): { operators: unknown[]; id: string; index: number; mode: 'added' | 'replaced' | 'kept' } {
  const result = buildManagedCandidate(buildOperatorSnapshot(entity), input, {
    position: input.position,
  });
  return { operators: result.storage, id: result.id, index: result.index, mode: result.mode };
}

/** The candidate's ALIGNED stored decode (parked rows become placeholders). */
export function decodeCandidate(candidateOperators: readonly unknown[]): StoredOperator[] {
  return StoredOperatorListSchema.parse(candidateOperators);
}

/**
 * Zero-write pipeline preview for a naming candidate (subscription): fetch
 * raw proxies WITHOUT cache writes, run the candidate operator pipeline with
 * read-only ordinals, dedup with the shared machine (a candidate active
 * managed rename-template manages the whole single source — the same
 * predicate the generic subscription preview route uses), and report the
 * same structured issues.
 */
export async function previewNamingSubscription(
  id: string,
  candidateOperators: readonly unknown[],
): Promise<{ before: NamesPayload; after: NamesPayload; issues: PreviewIssue[] }> {
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.notFound('目标不存在或不在当前配置文件的来源范围内。');
  // the candidate may preserve parked/primitive raw rows — decode once and
  // derive every runtime decision (deferUniqueNames + the managed predicate)
  // from the aligned stored decode, never from raw property access
  const decoded = decodeCandidate(candidateOperators);
  const candidateManaged = decoded.some(
    (op) => op.kind === 'rename-template' && op.disabled !== true,
  );
  const { proxies } = await resolveSubscriptionProxiesRaw(sub, {
    writeCache: false,
    deferUniqueNames: candidateManaged,
  });
  const identity = { key: sub.name, label: sub.display_name?.trim() || sub.name };
  const before = (proxies as ClashProxy[]).map((p) => withRawIdentity(p, identity));
  return runCandidatePreview(
    before,
    decoded,
    () => candidateManaged,
    () => identity,
  );
}

/** Zero-write pipeline preview for a naming candidate (collection). */
export async function previewNamingCollection(
  id: string,
  candidateOperators: readonly unknown[],
): Promise<{ before: NamesPayload; after: NamesPayload; issues: PreviewIssue[] }> {
  const collection = await getCollection(id);
  if (!collection) throw ProblemDetailsError.notFound('目标不存在或不在当前配置文件的来源范围内。');
  const subs = await listSubscriptions();
  const { merged } = await mergeCollectionMemberProxies(collection, subs, { writeCache: false });
  const decoded = decodeCandidate(candidateOperators);
  // the SAME per-item dedup predicate the generic collection preview route
  // uses: a candidate active collection-level rename-template manages every
  // node; otherwise each member's own saved managed op decides its nodes
  const collectionManagedOp = decoded.some(
    (op) => op.kind === 'rename-template' && op.disabled !== true,
  );
  const memberManagedByKey = new Map(
    enabledCollectionMemberSubs(collection, subs).map((m) => [
      m.name,
      (m.operators ?? []).some((op) => op.kind === 'rename-template' && op.disabled !== true),
    ]),
  );
  const before = merged as ClashProxy[];
  return runCandidatePreview(
    before,
    decoded,
    (item) => {
      if (collectionManagedOp) return true;
      const key = sourceOf(item)?.key;
      return key !== undefined && memberManagedByKey.get(key) === true;
    },
    (proxy) => sourceOf(proxy),
  );
}

async function runCandidatePreview(
  before: ClashProxy[],
  decoded: StoredOperator[],
  managedPredicate: (item: unknown) => boolean,
  identityOf: (proxy: unknown) => { key: string; label: string } | undefined,
): Promise<{ before: NamesPayload; after: NamesPayload; issues: PreviewIssue[] }> {
  const managedOp = decoded.find(
    (op): op is Extract<Operator, { kind: 'rename-template' }> => op.kind === 'rename-template',
  );
  const ordinals = await resolveOrdinalsFor(before, identityOf, {
    persist: false,
    template: managedOp?.template,
    recognitionRules: managedOp?.recognitionRules ?? [],
  });
  const { proxies: after, steps } = applyOperators(before, decoded as Operator[], ordinals);
  const final = dedupExportProxies(after, managedPredicate);
  const dedupIssues = dedupMachineIssues(final);
  return {
    before: namesPayload(before),
    after: namesPayload(final.proxies),
    issues: [...(await buildPreviewIssues(before, final.proxies, steps)), ...dedupIssues],
  };
}

/** Preview steps projected for the response (source keys → src handles). */
export { projectStepsSourceKeys };
