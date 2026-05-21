import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteCollection,
  getCollection,
  patchCollection,
} from '@/lib/services/collectionService';
import { CollectionUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/collections/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const col = await getCollection(id);
  if (!col) throw ProblemDetailsError.notFound(`Collection ${id} not found.`);
  return Response.json({ data: col });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = CollectionUpdateSchema.parse(raw);
  const updated = await patchCollection(id, patch);
  return Response.json({ data: updated });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const removed = await deleteCollection(id);
  if (!removed) throw ProblemDetailsError.notFound(`Collection ${id} not found.`);
  return new Response(null, { status: 204 });
});
