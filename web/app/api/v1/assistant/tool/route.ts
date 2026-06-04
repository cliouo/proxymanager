/**
 * POST /api/v1/assistant/tool — execute ONE tool call for the browser-side
 * orchestrator. Body: { name, input }. Reads run inline and return their
 * envelope; writes preview + mint a confirmation token and return a
 * confirm-write payload (executed later via /api/v1/assistant/confirm).
 *
 * One action per request → each invocation is short, so the Vercel 60s cap is
 * never a factor (the long agent loop lives in the browser). Admin-gated by
 * proxy.ts.
 */

import { z } from 'zod';
import { dispatchToolCall } from '@/lib/ai/dispatchTool';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

const ToolRequestSchema = z.object({
  name: z.string().min(1).max(64),
  input: z.unknown().optional(),
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { name, input } = ToolRequestSchema.parse(raw);
  const result = await dispatchToolCall({ actor: resolveActor(request) }, name, input ?? {});
  return Response.json({ data: result });
});
