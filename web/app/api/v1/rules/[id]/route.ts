import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getRule } from '@/lib/repos/rulesRepo';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { resolveActor } from '@/lib/services/rulesService';
import { type Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/rules/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const rule = await getRule(id);
  if (!rule) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);
  return Response.json({ data: rule });
});

/* ─── Mutation routes — thin shims over the rule-anchor-append scenario ─ */

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const result = await dispatch({
    scenario: 'rule-anchor-append',
    op: 'replace',
    payload: { id, rule: body },
    actor: resolveActor(request),
  });
  return Response.json({ data: result.data as Rule });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const result = await dispatch({
    scenario: 'rule-anchor-append',
    op: 'patch',
    payload: { id, patch: body },
    actor: resolveActor(request),
  });
  return Response.json({ data: result.data as Rule });
});

export const DELETE = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await dispatch({
    scenario: 'rule-anchor-append',
    op: 'delete',
    payload: { id },
    actor: resolveActor(request),
  });
  return new Response(null, { status: 204 });
});
