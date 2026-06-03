import { z } from 'zod';

/**
 * Assistant runtime config — the user's own DeepSeek (or OpenAI-compatible)
 * credentials and model knobs. Since this is a single-user personal
 * deployment, the browser holds the agent loop and calls the model API
 * directly; this config is stored in KV, served to the browser on page load,
 * and cached in localStorage so per-turn calls don't hit KV.
 *
 * The shape mirrors what `lib/ai/deepseek.ts` sends today (model + thinking +
 * reasoning_effort), so the client request builder can reuse the contract.
 */

export const AssistantThinkingSchema = z.enum(['enabled', 'disabled']);
export const AssistantReasoningEffortSchema = z.enum(['low', 'medium', 'high']);

export const AssistantConfigSchema = z.object({
  /** OpenAI-compatible base URL; DeepSeek default. No trailing /chat/completions. */
  baseUrl: z.string().min(1).default('https://api.deepseek.com'),
  model: z.string().min(1).default('deepseek-v4-pro'),
  /** Sent straight to the model API from the browser. */
  apiKey: z.string().min(1),
  thinking: AssistantThinkingSchema.default('enabled'),
  reasoningEffort: AssistantReasoningEffortSchema.default('high'),
  maxTokens: z.number().int().positive().max(65536).default(8192),
  updated_at: z.number().int().optional(),
});

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;

/** Update payload — every field optional; `apiKey` omitted keeps the stored one. */
export const AssistantConfigUpdateSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  thinking: AssistantThinkingSchema.optional(),
  reasoningEffort: AssistantReasoningEffortSchema.optional(),
  maxTokens: z.number().int().positive().max(65536).optional(),
});

export type AssistantConfigUpdate = z.infer<typeof AssistantConfigUpdateSchema>;
