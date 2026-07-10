import { z } from 'zod';

/**
 * P3-17: cap request body sizes so an oversized payload fails as a clean 422
 * (Upstash rejects >~1MB values, which otherwise surfaces as an opaque 500).
 * These ceilings are generous for real content — a base skeleton is a few KB,
 * a local rule-set / provider YAML at most a few thousand lines.
 */
export const MAX_BASE_CONTENT = 512 * 1024;
export const MAX_RULESET_CONTENT = 2 * 1024 * 1024;
export const MAX_SUBSCRIPTION_CONTENT = 4 * 1024 * 1024;

export const BaseConfigSchema = z.object({
  content: z.string(),
  anchors: z.array(z.string()),
  policies: z.array(z.string()),
  etag: z.string(),
  updated_at: z.number().int(),
});

export const BaseUpdateRequestSchema = z.object({
  content: z.string().min(1).max(MAX_BASE_CONTENT, 'base 内容过大'),
});

export const BaseOrphanSchema = z.object({
  rule_id: z.string(),
  reason: z.string(),
});

export const BaseValidationResultSchema = z.object({
  valid: z.boolean(),
  anchors: z.array(z.string()),
  policies: z.array(z.string()),
  orphans: z.array(BaseOrphanSchema),
});

export type BaseConfig = z.infer<typeof BaseConfigSchema>;
export type BaseUpdateRequest = z.infer<typeof BaseUpdateRequestSchema>;
export type BaseOrphan = z.infer<typeof BaseOrphanSchema>;
export type BaseValidationResult = z.infer<typeof BaseValidationResultSchema>;
