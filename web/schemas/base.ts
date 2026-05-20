import { z } from 'zod';

export const BaseConfigSchema = z.object({
  content: z.string(),
  anchors: z.array(z.string()),
  policies: z.array(z.string()),
  etag: z.string(),
  updated_at: z.number().int(),
});

export const BaseUpdateRequestSchema = z.object({
  content: z.string().min(1),
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
