import { z } from 'zod';

/**
 * A user-maintained rule-set file (Mihomo `rule-providers` URL target).
 * `format` is a hint for the UI / future syntax-aware validation; the raw
 * `content` is what gets served verbatim at /api/rule-providers/{token}/{name}.
 */
export const RuleSetFormatSchema = z.enum(['yaml', 'text']);

export const RuleSetSchema = z.object({
  id: z.uuid(),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'must contain only lowercase letters, digits, underscores, or dashes'),
  format: RuleSetFormatSchema,
  /** Behavior hint that matches mihomo's rule-provider `behavior:` field. */
  behavior: z.enum(['classical', 'domain', 'ipcidr']).optional(),
  content: z.string(),
  note: z.string().optional(),
  updated_at: z.number().int(),
});

export const RuleSetCreateSchema = RuleSetSchema.omit({ id: true, updated_at: true });
export const RuleSetUpdateSchema = RuleSetCreateSchema.partial();

export type RuleSet = z.infer<typeof RuleSetSchema>;
export type RuleSetFormat = z.infer<typeof RuleSetFormatSchema>;
export type RuleSetCreate = z.infer<typeof RuleSetCreateSchema>;
export type RuleSetUpdate = z.infer<typeof RuleSetUpdateSchema>;
