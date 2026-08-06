import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { withRawIdentity } from '@/lib/proxies/naming';
import {
  buildPreviewIssues,
  dedupMachineIssues,
  namesPayload,
  projectStepsSourceKeys,
} from '@/lib/services/pipelinePreview';
import { dedupExportProxies } from '@/lib/services/nodeExportService';
import { resolveOrdinalsFor } from '@/lib/services/nodeOrdinalService';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import { getSubscription } from '@/lib/services/subscriptionService';
import { isActiveCurrentRenameTemplateOperator, OperatorListSchema } from '@/schemas';

export const dynamic = 'force-dynamic';
// P3-18: fetches the upstream + runs the operator pipeline; explicit ceiling.
export const maxDuration = 60;

type Ctx = RouteContext<'/api/v1/subscriptions/[id]/preview'>;

/**
 * Dry-run a node-processing pipeline against a subscription's *raw* (pre-
 * operator) proxies, WITHOUT saving. The workbench posts the operators it's
 * currently editing; we fetch the sub's cached raw proxies, run the pipeline,
 * and return before/after node names, a per-step trace, and structured
 * credential-free issues (duplicate final names, resolved rename-template
 * collisions, true-duplicate drops, references a rename/filter would orphan).
 *
 * Preview is a read-only dry-run: fresh upstream fetches are NOT persisted
 * into the fetch cache (`writeCache: false`) — a keystroke-driven preview
 * must never mutate shared cache state — and persisted node-ordinal
 * assignments are resolved read-only (never published by a candidate).
 * Uniqueness deferral follows the CANDIDATE pipeline: a draft that adds
 * managed naming may preview raw duplicate names that the managed stage
 * would repair.
 */
export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);

  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const operators = OperatorListSchema.parse(raw?.operators ?? []);
  const noCache = raw?.noCache === true;

  // Raw proxies = upstream fetched + normalised, pipeline NOT yet applied.
  // Object-level entry point — no YAML stringify/parse round-trip just to
  // hand applyOperators the very objects the fetcher already had.
  const { proxies } = await resolveSubscriptionProxiesRaw(sub, {
    noCache,
    writeCache: false,
    deferUniqueNames: operators.some(isActiveCurrentRenameTemplateOperator),
  });
  // Single-subscription provenance: the rename-template operator reads the
  // source alias + per-source index from it (enumerable Symbol, never
  // serialised into the response). The raw identity fingerprint is computed
  // here from the raw objects — byte-identical to the fetch-boundary value.
  const identity = { key: sub.name, label: sub.display_name?.trim() || sub.name };
  const before = (proxies as ClashProxy[]).map((p) => withRawIdentity(p, identity));

  const managedOp = operators.find(isActiveCurrentRenameTemplateOperator);
  const ordinals = await resolveOrdinalsFor(before, () => identity, {
    persist: false,
    template: managedOp?.template,
    recognitionRules: managedOp?.recognitionRules ?? [],
  });
  const { proxies: after, steps } = applyOperators(before, operators, ordinals);

  // FINAL identity/name pass (pass-1 finding): the public preview runs the
  // SAME provenance-aware global dedup state machine as render, single-
  // subscription export and collection export — after the candidate pipeline,
  // with the candidate's per-node managed provenance (a posted active
  // rename-template manages the whole single source, exactly like the export
  // path). The preview must never show N,N,M where every other path yields
  // two identities.
  const candidateManaged = operators.some(isActiveCurrentRenameTemplateOperator);
  const final = dedupExportProxies(after, () => candidateManaged);
  const dedupIssues = dedupMachineIssues(final);

  return Response.json({
    data: {
      before: namesPayload(before),
      after: namesPayload(final.proxies),
      steps: projectStepsSourceKeys(steps),
      issues: [...(await buildPreviewIssues(before, final.proxies, steps)), ...dedupIssues],
    },
  });
});
