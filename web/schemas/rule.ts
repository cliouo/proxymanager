import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { RuleSourceSchema, RuleTypeSchema } from './common';

/**
 * Render a rule to its single mihomo `rules:` line. Kept here (the write-path
 * schema) so both {@link renderRule} in the engine and the injection guard
 * below agree on the exact byte layout — a drift would let a value that passes
 * validation render into something the guard never saw.
 */
export function ruleLine(data: {
  type: string;
  value?: string;
  policy: string;
  options?: string[];
}): string {
  if (data.type === 'MATCH') return `MATCH,${data.policy}`;
  const modifiers = data.options?.length ? `,${data.options.join(',')}` : '';
  return `${data.type},${data.value ?? ''},${data.policy}${modifiers}`;
}

/**
 * A rendered rule line is a single YAML sequence entry: `- <line>`. A value /
 * policy / option carrying a newline, a `: ` map trigger or a ` #` comment
 * would either smuggle a second rule or reparse the entry into a map — mihomo
 * then rejects the whole config. Reject any rule whose rendered line does not
 * round-trip back to the exact same scalar. Pure structural check; no external
 * state. See P2-4 in the code review.
 */
function rendersAsSingleScalar(
  data: { type: string; value?: string; policy: string; options?: string[] },
  ctx: z.RefinementCtx,
): void {
  // Fast reject on raw control chars first — cheaper and a clearer message.
  const fields: Array<[string, string | undefined]> = [
    ['value', data.value],
    ['policy', data.policy],
  ];
  for (const opt of data.options ?? []) fields.push(['options', opt]);
  for (const [path, v] of fields) {
    // Reject C0 control chars (incl. \t \n \r) and DEL outright — they break the YAML line.
    if (typeof v === 'string' && /[\u0000-\u001f\u007f]/.test(v)) {
      ctx.addIssue({
        code: 'custom',
        message: '不能包含换行或控制字符（会破坏渲染出的 YAML 规则行）',
        path: [path],
      });
      return;
    }
  }
  const line = ruleLine(data);
  let parsed: unknown;
  try {
    parsed = parseYaml(`- ${line}`);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: '该规则渲染后不是合法的 YAML 单行,请检查是否含特殊字符',
      path: ['value'],
    });
    return;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] !== line) {
    ctx.addIssue({
      code: 'custom',
      message: '规则字段含 YAML 敏感序列（如 ": " 或 " #"），会改变渲染结果',
      path: ['value'],
    });
  }
}

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
export function valueRequiredUnlessMatch(
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

/** The full write-path refine chain for a resolved rule (value-required + YAML-safe). */
function ruleWriteRefine(
  data: { type: string; value?: string; policy: string; options?: string[] },
  ctx: z.RefinementCtx,
): void {
  valueRequiredUnlessMatch(data, ctx);
  rendersAsSingleScalar(data, ctx);
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
  .superRefine(ruleWriteRefine);

export const RuleReplaceSchema = RuleSchema.omit({
  id: true,
  added_at: true,
  updated_at: true,
}).superRefine(ruleWriteRefine);

/**
 * Validate a fully-merged rule (existing record + a PATCH / batch-update
 * overlay) against the same invariants the create/replace paths enforce.
 * PATCH accepts partial fields, so `value:''` on a DOMAIN rule or a smuggled
 * newline slips past {@link RulePatchSchema} alone — the merged result must be
 * re-checked before it is persisted. Throws a {@link z.ZodError} on failure so
 * route handlers surface it as a 422. See P2-3 / P2-4.
 */
export function assertMergedRuleRenderable(merged: {
  anchor: string;
  type: string;
  value?: string;
  policy: string;
  rank: number;
  source: string;
  options?: string[];
  enabled?: boolean;
  note?: string;
}): void {
  // Runs valueRequiredUnlessMatch + rendersAsSingleScalar; throws z.ZodError.
  RuleReplaceSchema.parse(merged);
}

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
