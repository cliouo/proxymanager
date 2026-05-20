import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { recordEvent } from '@/lib/repos/auditRepo';
import { deleteRule, getRule, upsertRule } from '@/lib/repos/rulesRepo';
import {
  ensureValidAnchorAndPolicy,
  loadParsedBase,
  nowSeconds,
  resolveActor,
} from '@/lib/services/rulesService';
import { RulePatchSchema, RuleReplaceSchema, type Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/rules/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const rule = await getRule(id);
  if (!rule) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);
  return Response.json({ data: rule });
});

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const existing = await getRule(id);
  if (!existing) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const body = RuleReplaceSchema.parse(raw);

  const parsedBase = await loadParsedBase();
  ensureValidAnchorAndPolicy(body, parsedBase);

  const updated: Rule = {
    id,
    anchor: body.anchor,
    type: body.type,
    value: body.value,
    policy: body.policy,
    rank: body.rank,
    source: body.source,
    note: body.note,
    added_at: existing.added_at,
    updated_at: nowSeconds(),
  };
  await upsertRule(updated);
  await recordEvent({
    op: 'rule.update',
    actor: resolveActor(request),
    ruleId: id,
    before: existing,
    after: updated,
  });
  return Response.json({ data: updated });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const existing = await getRule(id);
  if (!existing) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = RulePatchSchema.parse(raw);

  const updated: Rule = {
    ...existing,
    ...patch,
    updated_at: nowSeconds(),
  };

  if (patch.anchor !== undefined || patch.policy !== undefined) {
    const parsedBase = await loadParsedBase();
    ensureValidAnchorAndPolicy({ anchor: updated.anchor, policy: updated.policy }, parsedBase);
  }

  await upsertRule(updated);
  await recordEvent({
    op: 'rule.update',
    actor: resolveActor(request),
    ruleId: id,
    before: existing,
    after: updated,
  });
  return Response.json({ data: updated });
});

export const DELETE = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const existing = await getRule(id);
  if (!existing) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  const removed = await deleteRule(id);
  if (!removed) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  await recordEvent({
    op: 'rule.delete',
    actor: resolveActor(request),
    ruleId: id,
    before: existing,
  });
  return new Response(null, { status: 204 });
});
