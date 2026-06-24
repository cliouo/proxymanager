/**
 * POST /api/v1/assistant/chat — streaming assistant endpoint (SSE).
 *
 * Auth: the `proxy.ts` middleware already requires `Bearer <ADMIN_KEY>` for
 * every /api/v1/* path, so this handler trusts the caller.
 *
 * Body: { conversationId, message } — only the new user turn; prior turns
 * (incl. tool calls/results) are kept server-side, keyed by conversationId.
 * Response: text/event-stream of AssistantEvent JSON frames, terminated by
 * a `{ "type": "done" }` frame.
 */

import { z } from 'zod';
import { hasDeepSeekKey } from '@/lib/ai/deepseek';
import { runAssistant, type AssistantEvent } from '@/lib/ai/orchestrator';
import { PROBLEM_BASE_URL, ProblemDetailsError, problemResponse } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';
// Agent loops (model + DeepWiki round-trips) can run several seconds.
// Vercel caps this by plan (Hobby 10s); raise the plan if you hit it.
export const maxDuration = 60;

const ChatRequestSchema = z.object({
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'invalid conversationId'),
  message: z.string().min(1).max(8000),
});

export async function POST(request: Request): Promise<Response> {
  const raw = await request.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return problemResponse({
      type: `${PROBLEM_BASE_URL}/validation-error`,
      title: 'Request validation failed',
      status: 422,
      errors: parsed.error.issues,
    });
  }

  if (!hasDeepSeekKey()) {
    return problemResponse(
      ProblemDetailsError.internal('缺少 DEEPSEEK_API_KEY，助手未配置。').problem,
    );
  }

  const actor = resolveActor(request);
  const { id: profileId } = await resolveScopeProfile(request);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const frame = (event: AssistantEvent | { type: 'done' }) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        await runAssistant({
          actor,
          profileId,
          conversationId: parsed.data.conversationId,
          userMessage: parsed.data.message,
          emit: frame,
          signal: request.signal,
        });
      } catch (err) {
        frame({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        frame({ type: 'done' });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
