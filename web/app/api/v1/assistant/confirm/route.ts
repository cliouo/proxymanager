/**
 * POST /api/v1/assistant/confirm — execute a write the user authorised.
 *
 * Second step of the confirmation handshake. Body: { token }. The token is
 * consumed atomically (one-time); its stored {actor, action, input} is run
 * through the write action's `execute`, which dispatches the scenario op so
 * the change is audited. Undo is offered only for operations with a safe
 * registered inverse. Auth is enforced by proxy.ts.
 */

import { z } from '@/lib/openapi/zod';
import { getAction } from '@/lib/ai/actions/registry';
import { assertWriteAllowed } from '@/lib/ai/actions/neverList';
import { consumeConfirmation } from '@/lib/ai/confirm';
import { projectWriteResult, UNKNOWN_OUTCOME_BODY } from '@/lib/ai/writeResultProjection';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

const ConfirmSchema = z.object({ token: z.string().min(1).max(128) });

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { token } = ConfirmSchema.parse(raw);

  const record = await consumeConfirmation(token);
  if (!record) {
    throw ProblemDetailsError.conflict('确认已失效或已使用，请重新发起。');
  }

  const action = getAction(record.action);
  if (!action || action.risk !== 'write') {
    throw ProblemDetailsError.unprocessable(`操作 "${record.action}" 不可执行。`);
  }
  assertWriteAllowed(action);

  // Re-validate the stored input through the action schema (defense in depth).
  const input = action.input.parse(record.input);
  // Use the profile captured at preview time so the confirmation executes
  // against the same profile the user reviewed.
  const envelope = await action.execute(
    {
      actor: resolveActor(request),
      profileId: record.profileId,
      ...(record.confirmation ? { confirmation: record.confirmation } : {}),
    },
    input,
  );

  // Round-9: the projection produces a hardened responseContent JSON string
  // built without reserializing ordinary objects/arrays. The route returns
  // it directly — never spreads the envelope, never calls Response.json on
  // an ordinary record/array. Unknown outcome uses the same hardened builder.
  const projection = projectWriteResult(envelope, action.name);
  if (projection.outcome !== 'ok' || projection.responseContent === null) {
    return new Response(UNKNOWN_OUTCOME_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(projection.responseContent, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
});
