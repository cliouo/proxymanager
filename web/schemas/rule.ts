import { z } from 'zod';
import { RuleSourceSchema, RuleTypeSchema } from './common';

export const RuleSchema = z.object({
  id: z.uuid(),
  anchor: z.string().min(1),
  type: RuleTypeSchema,
  // Empty only for MATCH (which takes no value); enforced on the write path by
  // `valueRequiredUnlessMatch`. Default lets MATCH payloads omit it entirely.
  value: z.string().default(''),
  policy: z.string().min(1),
  rank: z.number().int(),
  source: RuleSourceSchema,
  added_at: z.number().int(),
  updated_at: z.number().int(),
  note: z.string().optional(),
  // Trailing rule modifiers, e.g. ['no-resolve']. Appended verbatim by renderRule.
  options: z.array(z.string()).optional(),
  // false = parked/disabled: kept in the hash but skipped at render time.
  // undefined/true = active (legacy rules have no field and render normally).
  enabled: z.boolean().optional(),
});

/** A non-MATCH rule must carry a non-empty value; MATCH ignores value. */
function valueRequiredUnlessMatch(
  data: { type: string; value?: string },
  ctx: z.RefinementCtx,
): void {
  if (data.type !== 'MATCH' && (data.value === undefined || data.value.trim() === '')) {
    ctx.addIssue({
      code: 'custom',
      message: 'value is required unless type is MATCH',
      path: ['value'],
    });
  }
}

export const RuleCreateSchema = RuleSchema.omit({
  id: true,
  rank: true,
  added_at: true,
  updated_at: true,
})
  .extend({
    rank: z.number().int().optional(),
  })
  .superRefine(valueRequiredUnlessMatch);

export const RuleReplaceSchema = RuleSchema.omit({
  id: true,
  added_at: true,
  updated_at: true,
}).superRefine(valueRequiredUnlessMatch);

export const RulePatchSchema = z.object({
  anchor: z.string().min(1).optional(),
  type: RuleTypeSchema.optional(),
  value: z.string().optional(),
  policy: z.string().min(1).optional(),
  rank: z.number().int().optional(),
  source: RuleSourceSchema.optional(),
  note: z.string().optional(),
  options: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export type Rule = z.infer<typeof RuleSchema>;
export type RuleCreate = z.infer<typeof RuleCreateSchema>;
export type RuleReplace = z.infer<typeof RuleReplaceSchema>;
export type RulePatch = z.infer<typeof RulePatchSchema>;
