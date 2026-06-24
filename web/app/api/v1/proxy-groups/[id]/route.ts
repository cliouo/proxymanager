import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import {
  deleteProxyGroup,
  getProxyGroup,
  patchProxyGroup,
} from '@/lib/services/proxyGroupService';
import { ProxyGroupUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/proxy-groups/[id]'>;

export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const { id } = await ctx.params;
  const group = await getProxyGroup(profileId, id);
  if (!group) throw ProblemDetailsError.notFound(`proxy-group ${id} not found.`);
  return Response.json({ data: group });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = ProxyGroupUpdateSchema.parse(raw);
  const updated = await patchProxyGroup(profileId, id, patch);
  return Response.json({ data: updated });
});

export const DELETE = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const { id } = await ctx.params;
  const removed = await deleteProxyGroup(profileId, id);
  if (!removed) throw ProblemDetailsError.notFound(`proxy-group ${id} not found.`);
  return new Response(null, { status: 204 });
});
