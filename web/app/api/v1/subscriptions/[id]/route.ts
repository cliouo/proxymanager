import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteSubscription,
  getSubscription,
  patchSubscription,
  replaceSubscription,
} from '@/lib/services/subscriptionService';
import { SubscriptionCreateSchema, SubscriptionUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  return Response.json({ data: sub });
});

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = SubscriptionCreateSchema.parse(raw);
  const next = await replaceSubscription(id, input);
  return Response.json({ data: next });
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
  return Response.json({ data: next });
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
