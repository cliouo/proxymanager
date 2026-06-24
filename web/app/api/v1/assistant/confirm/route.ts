/**
 * POST /api/v1/assistant/confirm — execute a write the user authorised.
 *
 * Second step of the confirmation handshake. Body: { token }. The token is
 * consumed atomically (one-time); its stored {actor, action, input} is run
 * through the write action's `execute`, which dispatches the scenario op so
 * the change is audited and undoable. Auth is enforced by proxy.ts.
 */

import { z } from 'zod';
import { getAction } from '@/lib/ai/actions/registry';
import { assertWriteAllowed } from '@/lib/ai/actions/neverList';
import { consumeConfirmation } from '@/lib/ai/confirm';
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
    { actor: resolveActor(request), profileId: record.profileId },
    input,
  );

  return Response.json({ data: envelope });
});
