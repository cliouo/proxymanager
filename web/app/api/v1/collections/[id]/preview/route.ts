import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { sourceOf } from '@/lib/proxies/provenance';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { dedupExportProxies, mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { resolveOrdinalsFor } from '@/lib/services/nodeOrdinalService';
import {
  buildPreviewIssues,
  dedupMachineIssues,
  namesPayload,
  projectStepsSourceKeys,
  safeMemberErrors,
} from '@/lib/services/pipelinePreview';
import { getCollection } from '@/lib/services/collectionService';
import { listSubscriptions } from '@/lib/services/subscriptionService';
import { OperatorListSchema, type Operator } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/collections/[id]/preview'>;

/**
 * Dry-run a 聚合订阅's node-processing pipeline against its merged member
 * nodes, WITHOUT saving. The workbench posts the operators it's currently
 * editing; we merge the enabled members' processed nodes (each member's own
 * pipeline already ran at fetch), run the posted collection pipeline over the
 * union, and return before/after node names, a per-step trace, and structured
 * credential-free issues. `before` here = the merged member union (collection
 * operators not yet applied).
 *
 * Read-only dry-run: member fetches never write the fetch cache
 * (`writeCache: false`), persisted node-ordinal assignments are resolved
 * read-only (never published by a candidate), and per-member provenance is
 * carried on an enumerable Symbol that JSON serialisation drops
 * automatically.
 */
export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const collection = await getCollection(id);
  if (!collection) throw ProblemDetailsError.notFound(`Collection ${id} not found.`);

  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const operators = OperatorListSchema.parse(raw?.operators ?? []);
  const noCache = raw?.noCache === true;

  const subs = await listSubscriptions();
  const { merged, memberErrors } = await mergeCollectionMemberProxies(collection, subs, {
    noCache,
    writeCache: false,
  });
  const before = merged as ClashProxy[];

  const managedOp = operators.find(
    (op): op is Extract<Operator, { kind: 'rename-template' }> => op.kind === 'rename-template',
  );
  const ordinals = await resolveOrdinalsFor(before, sourceOf, {
    persist: false,
    template: managedOp?.template,
    recognitionRules: managedOp?.recognitionRules ?? [],
  });
  const { proxies: after, steps } = applyOperators(before, operators, ordinals);

  // FINAL identity/name pass (pass-1 finding): the public preview runs the
  // SAME provenance-aware global dedup state machine as render, single-
  // subscription export and collection export — after the candidate pipeline.
  // Managed provenance is PER-NODE: the candidate collection's active
  // rename-template promotes every node (the collection stage ran managed
  // naming over the merged set); otherwise only nodes whose own MEMBER
  // subscription has an active rename-template are managed — an unrelated
  // managed third member can never promote a plain/plain collision.
  const collectionManagedOp = operators.some(
    (op): op is Extract<Operator, { kind: 'rename-template' }> =>
      op.kind === 'rename-template' && op.disabled !== true,
  );
  const memberManagedByKey = new Map(
    enabledCollectionMemberSubs(collection, subs).map((m) => [
      m.name,
      (m.operators ?? []).some((op) => op.kind === 'rename-template' && op.disabled !== true),
    ]),
  );
  const final = dedupExportProxies(after, (item) => {
    if (collectionManagedOp) return true;
    const key = sourceOf(item)?.key;
    return key !== undefined && memberManagedByKey.get(key) === true;
  });
  const dedupIssues = dedupMachineIssues(final);

  return Response.json({
    data: {
      before: namesPayload(before),
      after: namesPayload(final.proxies),
      steps: projectStepsSourceKeys(steps),
      issues: [...(await buildPreviewIssues(before, final.proxies, steps)), ...dedupIssues],
      memberErrors: safeMemberErrors(memberErrors),
    },
  });
});
