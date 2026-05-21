import { z } from 'zod';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

const OpRequestSchema = z.object({
  scenario: z.string().min(1).max(64),
  op: z.string().min(1).max(64),
  payload: z.unknown(),
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { scenario, op, payload } = OpRequestSchema.parse(raw);
  const result = await dispatch({
    scenario,
    op,
    payload,
    actor: resolveActor(request),
  });
  return Response.json({ data: result.data, events: result.events });
});
