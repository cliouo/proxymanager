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
import { resolveScopeProfile } from '@/lib/profileScope';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';
// 与设备/订阅 preview 路由同档:get_config_full / preview_device_config 这类读
// action 可能触发冷渲染拉上游订阅,给明确上限而不是平台默认的 10s。
export const maxDuration = 60;

const ToolRequestSchema = z.object({
  name: z.string().min(1).max(64),
  input: z.unknown().optional(),
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { name, input } = ToolRequestSchema.parse(raw);
  const { id: profileId } = await resolveScopeProfile(request);
  const result = await dispatchToolCall(
    { actor: resolveActor(request), profileId },
    name,
    input ?? {},
  );
  return Response.json({ data: result });
});
