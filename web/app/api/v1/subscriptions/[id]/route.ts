import { withProblemDetails } from '@/lib/http/handler';
import { projectAliasKeysToHandles } from '@/lib/services/sourceAliasResolver';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteSubscription,
  getSubscriptionAdminView,
  patchSubscription,
  projectSubscriptionAdminView,
  replaceSubscription,
} from '@/lib/services/subscriptionService';
import { getSubscriptionFetchHealth } from '@/lib/repos/subscriptionFetchHealthRepo';
import {
  effectiveSubscriptionRefreshMode,
  SubscriptionCreateSchema,
  SubscriptionUpdateSchema,
  type Subscription,
} from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]'>;

async function projectCommittedSubscriptionAdminView(next: Subscription) {
  if (next.kind === 'remote' && effectiveSubscriptionRefreshMode(next) === 'server-auto') {
    return projectSubscriptionAdminView(next, await getSubscriptionFetchHealth(next.id));
  }
  return projectSubscriptionAdminView(next);
}

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const view = await getSubscriptionAdminView(id);
  if (!view) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  // pass-6 blocker 2: the external entity payload carries ONLY opaque src-*
  // alias handles — stored stable keys are projected at this boundary.
  const data = {
    ...view,
    operators: (view.operators ?? []).map((op) => {
      if ((op as { kind?: string }).kind !== 'rename-template') return op;
      const aliases = (op as { sourceAliases?: Record<string, string> }).sourceAliases;
      if (aliases === undefined) return op;
      return { ...op, sourceAliases: projectAliasKeysToHandles(aliases, [view.name]) };
    }),
  };
  return Response.json({ data });
});

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = SubscriptionCreateSchema.parse(raw);
  const next = await replaceSubscription(id, input);
  // Project only the committed candidate: local/manual rows are health-inert,
  // while effective server-auto rows retain the fingerprint-joined health read.
  const view = await projectCommittedSubscriptionAdminView(next);
  return Response.json({ data: view });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = SubscriptionUpdateSchema.parse(raw);
  // P2-2: If-Match carries the client's last-known updated_at (optimistic
  // version). Absent → undefined → unchanged last-write-wins behavior.
  const ifMatch = request.headers.get('if-match');
  const parsed = ifMatch ? Number(ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '')) : NaN;
  const expectedUpdatedAt = Number.isFinite(parsed) ? parsed : undefined;
  const next = await patchSubscription(id, patch, expectedUpdatedAt);
  // Project only the committed candidate: local/manual rows are health-inert,
  // while effective server-auto rows retain the fingerprint-joined health read.
  const view = await projectCommittedSubscriptionAdminView(next);
  return Response.json({ data: view });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { removed, warnings } = await deleteSubscription(id);
  if (!removed) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  // P0-2: delete-but-warn. When the deletion left references dangling, return
  // 200 + the warnings so the UI can tell the user; otherwise a clean 204.
  if (warnings.length > 0) return Response.json({ data: { warnings } }, { status: 200 });
  return new Response(null, { status: 204 });
});
