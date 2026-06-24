import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { getRuleSet } from '@/lib/services/ruleSetService';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/rule-sets/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const set = await getRuleSet(id);
  if (!set) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  return Response.json({ data: set });
});

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const res = await dispatch({
    scenario: 'rule-provider',
    op: 'replace',
    payload: { id, set: raw },
    actor: resolveActor(request),
    profileId,
  });
  return Response.json({ data: res.data });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const res = await dispatch({
    scenario: 'rule-provider',
    op: 'patch',
    payload: { id, patch: raw },
    actor: resolveActor(request),
    profileId,
  });
  return Response.json({ data: res.data });
});

export const DELETE = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const { id } = await ctx.params;
  await dispatch({
    scenario: 'rule-provider',
    op: 'delete',
    payload: { id },
    actor: resolveActor(request),
    profileId,
  });
  return new Response(null, { status: 204 });
});
