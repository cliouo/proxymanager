import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { listRuleSets } from '@/lib/services/ruleSetService';
import { resolveActor } from '@/lib/services/rulesService';
import type { RuleSet } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const sets = await listRuleSets();
  return Response.json({ data: sets, meta: { total: sets.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const res = await dispatch({
    scenario: 'rule-provider',
    op: 'create',
    payload: raw,
    actor: resolveActor(request),
  });
  const created = res.data as RuleSet;
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/rule-sets/${created.id}` } },
  );
});
