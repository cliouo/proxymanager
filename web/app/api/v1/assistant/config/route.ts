/**
 * GET/PUT /api/v1/assistant/config — the user's DeepSeek credentials + model
 * knobs for the browser-side assistant. Admin-gated by the proxy.ts middleware
 * like every /api/v1/* path. GET returns the full config (incl. apiKey) so the
 * browser can call the model API directly; PUT merges a partial update so the
 * caller can change knobs without resending the key.
 */

import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getAssistantConfig, setAssistantConfig } from '@/lib/repos/assistantConfigRepo';
import { AssistantConfigSchema, AssistantConfigUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const config = await getAssistantConfig();
  if (!config) throw ProblemDetailsError.notFound('AI 助手尚未配置；请先在「AI 配置」页填入 DeepSeek 凭证。');
  return Response.json({ data: config });
});

export const PUT = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = AssistantConfigUpdateSchema.parse(raw);
  const current = await getAssistantConfig();

  // Merge onto current (or defaults). A PUT without apiKey keeps the stored key,
  // so the settings page can save knob changes without re-entering the secret.
  const merged = AssistantConfigSchema.parse({
    ...(current ?? {}),
    ...patch,
    updated_at: Math.floor(Date.now() / 1000),
  });

  await setAssistantConfig(merged);
  return Response.json({ data: merged });
});
