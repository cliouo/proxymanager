import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { getCollection } from '@/lib/services/collectionService';
import { listSubscriptions } from '@/lib/services/subscriptionService';
import { OperatorListSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/collections/[id]/preview'>;

/** Cap the node-name lists in the response so previewing a huge collection stays light. */
const NAME_CAP = 300;

/**
 * Dry-run a 聚合订阅's node-processing pipeline against its merged member nodes,
 * WITHOUT saving. The workbench posts the operators it's currently editing; we
 * merge the enabled members' processed nodes (each member's own pipeline already
 * ran at fetch), run the posted collection pipeline over the union, and return
 * before/after node names plus a per-step trace. `before` here = the merged
 * member union (collection operators not yet applied).
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
  });
  const before = merged as ClashProxy[];

  const { proxies: after, steps } = applyOperators(before, operators);

  return Response.json({
    data: {
      before: namesPayload(before),
      after: namesPayload(after),
      steps,
      memberErrors,
    },
  });
});

function namesPayload(proxies: ClashProxy[]): {
  count: number;
  names: string[];
  truncated: boolean;
} {
  const names = proxies
    .slice(0, NAME_CAP)
    .map((p) => (typeof p.name === 'string' ? p.name : '(无名)'));
  return { count: proxies.length, names, truncated: proxies.length > NAME_CAP };
}
