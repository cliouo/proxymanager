import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import { getSubscription } from '@/lib/services/subscriptionService';
import { OperatorListSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]/preview'>;

/** Cap the node-name lists in the response so previewing a huge sub stays light. */
const NAME_CAP = 300;

/**
 * Dry-run a node-processing pipeline against a subscription's *raw* (pre-
 * operator) proxies, WITHOUT saving. The workbench posts the operators it's
 * currently editing; we fetch the sub's cached raw proxies, run the pipeline,
 * and return before/after node names plus a per-step trace.
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
  const { proxies } = await resolveSubscriptionProxiesRaw(sub, { noCache });
  const before = proxies as ClashProxy[];

  const { proxies: after, steps } = applyOperators(before, operators);

  return Response.json({
    data: {
      before: namesPayload(before),
      after: namesPayload(after),
      steps,
    },
  });
});

function namesPayload(proxies: ClashProxy[]): { count: number; names: string[]; truncated: boolean } {
  const names = proxies
    .slice(0, NAME_CAP)
    .map((p) => (typeof p.name === 'string' ? p.name : '(无名)'));
  return { count: proxies.length, names, truncated: proxies.length > NAME_CAP };
}
