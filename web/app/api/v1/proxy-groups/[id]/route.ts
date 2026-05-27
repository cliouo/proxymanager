import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteProxyGroup,
  getProxyGroup,
  patchProxyGroup,
} from '@/lib/services/proxyGroupService';
import { ProxyGroupUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/proxy-groups/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const group = await getProxyGroup(id);
  if (!group) throw ProblemDetailsError.notFound(`proxy-group ${id} not found.`);
  return Response.json({ data: group });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = ProxyGroupUpdateSchema.parse(raw);
  const updated = await patchProxyGroup(id, patch);
  return Response.json({ data: updated });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const removed = await deleteProxyGroup(id);
  if (!removed) throw ProblemDetailsError.notFound(`proxy-group ${id} not found.`);
  return new Response(null, { status: 204 });
});
