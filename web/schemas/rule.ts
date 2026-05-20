import { z } from 'zod';
import { RuleSourceSchema, RuleTypeSchema } from './common';

export const RuleSchema = z.object({
  id: z.uuid(),
  anchor: z.string().min(1),
  type: RuleTypeSchema,
  value: z.string(),
  policy: z.string().min(1),
  rank: z.number().int(),
  source: RuleSourceSchema,
  added_at: z.number().int(),
  updated_at: z.number().int(),
  note: z.string().optional(),
});

export const RuleCreateSchema = RuleSchema.omit({
  id: true,
  rank: true,
  added_at: true,
  updated_at: true,
}).extend({
  rank: z.number().int().optional(),
});

export const RuleReplaceSchema = RuleSchema.omit({
  id: true,
  added_at: true,
  updated_at: true,
});

export const RulePatchSchema = z.object({
  anchor: z.string().min(1).optional(),
  type: RuleTypeSchema.optional(),
  value: z.string().optional(),
  policy: z.string().min(1).optional(),
  rank: z.number().int().optional(),
  source: RuleSourceSchema.optional(),
  note: z.string().optional(),
});

export type Rule = z.infer<typeof RuleSchema>;
export type RuleCreate = z.infer<typeof RuleCreateSchema>;
export type RuleReplace = z.infer<typeof RuleReplaceSchema>;
export type RulePatch = z.infer<typeof RulePatchSchema>;
