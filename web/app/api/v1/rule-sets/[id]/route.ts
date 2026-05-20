import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteRuleSet,
  getRuleSet,
  patchRuleSet,
  replaceRuleSet,
} from '@/lib/services/ruleSetService';
import { RuleSetCreateSchema, RuleSetUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/rule-sets/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const set = await getRuleSet(id);
  if (!set) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  return Response.json({ data: set });
});

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = RuleSetCreateSchema.parse(raw);
  const next = await replaceRuleSet(id, input);
  return Response.json({ data: next });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = RuleSetUpdateSchema.parse(raw);
  const next = await patchRuleSet(id, patch);
  return Response.json({ data: next });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const removed = await deleteRuleSet(id);
  if (!removed) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  return new Response(null, { status: 204 });
});
