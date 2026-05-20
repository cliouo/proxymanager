import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { createRuleSet, listRuleSets } from '@/lib/services/ruleSetService';
import { RuleSetCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const sets = await listRuleSets();
  return Response.json({ data: sets, meta: { total: sets.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = RuleSetCreateSchema.parse(raw);
  const created = await createRuleSet(input);
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/rule-sets/${created.id}` } },
  );
});
