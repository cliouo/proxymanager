/**
 * GET /api/v1/assistant/bootstrap — everything the browser-side orchestrator
 * needs to talk to the model: the authoritative system prompt and the tool
 * JSON schemas (derived from the action registry). Served from the server so
 * the client never imports the registry (which pulls in Redis / node-only
 * deps). Admin-gated by proxy.ts.
 */

import { listActions } from '@/lib/ai/actions/registry';
import { SYSTEM_PROMPT } from '@/lib/ai/systemPrompt';
import { actionsToTools } from '@/lib/ai/toolSchema';
import { withProblemDetails } from '@/lib/http/handler';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  return Response.json({
    data: {
      systemPrompt: SYSTEM_PROMPT,
      tools: actionsToTools(listActions()),
    },
  });
});
