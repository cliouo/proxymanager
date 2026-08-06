/**
 * Shared strict request/response contract for the naming-analysis AI surface.
 *
 * ONE schema owns the opaque `{ ref }` request and the exact scrubbed
 * payload + suggestion response, so the workspace UI, the one-shot analysis
 * route, the assistant actions and the tests all share one type — the
 * client never sends raw `{ type, id }`, and `sources[].label ?? sources[].id`
 * is the ONLY sanctioned source rendering.
 *
 * Every object here is `.strict()`: the request rejects any extra field
 * (an obsolete `{ type, id }` request fails closed), and the payload rows
 * reject unknown keys so raw fields can never ride along silently.
 *
 * Privacy contract: the payload sent to the model contains bounded,
 * structurally redacted ORIGINAL display names (credentials/URLs/endpoints/
 * internal ids removed) and safe source display labels; source references
 * are opaque `src-` handles, never stable keys.
 */

import { z } from '@/lib/openapi/zod';
import { RecognitionRuleSchema } from '@/schemas/operator';
import { validateTemplate } from '@/lib/proxies/naming';

/** Canonical opaque target-ref shape (mirrors namingTargetScope.NAMING_REF_RE
 * — the profile-bound keyed handle the model-facing surfaces accept). */
export const NAMING_REF_RE = /^ref-[0-9a-f]{16}$/;

/** ONE strict request schema: the profile-bound opaque ref only. A request
 * carrying ANY other key (raw `type`/`id` included) fails at parse. */
export const NamingAnalysisRefSchema = z
  .object({
    ref: z
      .string()
      .regex(NAMING_REF_RE, '目标引用格式不正确(先用 list_naming_targets 拿 ref)')
      .describe('不透明目标引用(绝不传原始 UUID/type)'),
  })
  .strict();

export type NamingAnalysisRef = z.infer<typeof NamingAnalysisRefSchema>;

/**
 * The ONE way the UI builds an analysis request: from the workspace payload's
 * profile-bound opaque ref. Raw `{ type, id }` never enters this shape —
 * both the subscription and collection workspaces call this builder.
 */
export function namingAnalysisRequest(entityRef: string): NamingAnalysisRef {
  return { ref: entityRef };
}

/** One sanitized node feature the model may see (bounded name or null). */
export const NameFeatureSchema = z
  .object({
    i: z.number().int().nonnegative(),
    name: z.string().max(48).nullable(),
    src: z.string().nullable(),
    region: z.string().nullable(),
    rate: z.number().nullable(),
    route: z.string().nullable(),
    entry: z.string().nullable(),
    vendor: z.string().nullable(),
    type: z.string().nullable(),
    hasResidual: z.boolean(),
  })
  .strict();

export type NameFeature = z.infer<typeof NameFeatureSchema>;

/** One source the model may reference: opaque src- handle + sanitized label. */
export const ScrubbedSourceSchema = z
  .object({
    id: z.string().regex(/^src-[0-9a-f]{16}$/, '来源句柄格式不正确'),
    label: z.string().max(48).nullable(),
  })
  .strict();

export type ScrubbedSource = z.infer<typeof ScrubbedSourceSchema>;

/** The EXACT scrubbed payload the model receives (true totals, bounded rows). */
export const ScrubbedPayloadSchema = z
  .object({
    nodeCount: z.number().int().nonnegative(),
    sampled: z.number().int().nonnegative(),
    nodes: z.array(NameFeatureSchema),
    sources: z.array(ScrubbedSourceSchema),
    sourcesTotal: z.number().int().nonnegative(),
    sourcesTruncated: z.boolean(),
    regions: z.array(
      z.object({ code: z.string(), count: z.number().int().nonnegative() }).strict(),
    ),
    regionsTotal: z.number().int().nonnegative(),
    regionsTruncated: z.boolean(),
    rates: z.array(z.number()),
    ratesTotal: z.number().int().nonnegative(),
    ratesTruncated: z.boolean(),
  })
  .strict();

export type ScrubbedPayload = z.infer<typeof ScrubbedPayloadSchema>;

/** Strict output schema — model suggestions never enter the app unchecked. */
export const NamingSuggestionSchema = z
  .object({
    /** The placeholder-template DSL string — bounded AND DSL-validated. */
    template: z
      .string()
      .min(1, '模板不能为空')
      .max(512, '模板过长')
      .superRefine((template, ctx) => {
        const validation = validateTemplate(template);
        if (!validation.ok) {
          ctx.addIssue({ code: 'custom', message: validation.message });
        }
      }),
    /** 台湾节点用中国旗。省略=显式 false（round-7 HIGH-A：AI 建议是完整
     * 方案，模型输出缺省在边界处归一为 false，与空别名/空规则同一语义；
     * 若留作 undefined，预览/应用 JSON 会丢键、服务端按「沿用已保存」补
     * 丁，UI 却宣称整份替换）。 */
    tw2cn: z.boolean().default(false),
    sourceAliases: z
      .record(z.string(), z.string().min(1).max(40, '来源别名过长'))
      .refine((v) => Object.keys(v).length <= 64, '来源别名表过大')
      .default({}),
    recognitionRules: z.array(RecognitionRuleSchema).max(32).default([]),
    /** 一句话说明建议理由（≤200 字符，仅展示用）。 */
    reason: z.string().max(200),
  })
  .strict();

export type NamingSuggestion = z.infer<typeof NamingSuggestionSchema>;

/** The exact analysis response: the suggestion + the payload that was sent. */
export const NamingAnalysisResponseSchema = z
  .object({
    data: z
      .object({
        suggestion: NamingSuggestionSchema,
        payload: ScrubbedPayloadSchema,
      })
      .strict(),
  })
  .strict();

export type NamingAnalysisResponse = z.infer<typeof NamingAnalysisResponseSchema>;
