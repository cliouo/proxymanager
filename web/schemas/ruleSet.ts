import { z } from 'zod';
import { MAX_RULESET_CONTENT } from './base';

/**
 * A platform-managed rule-set — the single library entry the project owns end
 * to end. Two flavours, picked by `source`:
 *
 *   - `local`  : content hosted by this app, served verbatim at
 *                /api/rule-providers/{token}/{name}. `content` is the payload.
 *   - `remote` : an external rule list (e.g. a GitHub raw URL or a .mrs file).
 *                `url` is fetched by mihomo directly; `content` is unused.
 *
 * The base.yaml `rule-providers:` block is NOT hand-written any more. At render
 * time the engine emits a declaration for every rule-set that an enabled
 * RULE-SET rule actually references — unreferenced library entries cost nothing
 * and are simply left out of the delivered config.
 */
export const RuleSetFormatSchema = z.enum(['yaml', 'text', 'mrs']);
export const RuleSetBehaviorSchema = z.enum(['classical', 'domain', 'ipcidr']);
export const RuleSetSourceSchema = z.enum(['local', 'remote']);

export const RuleSetSchema = z.object({
  id: z.uuid(),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'must contain only lowercase letters, digits, underscores, or dashes'),
  /** local = hosted by us; remote = external url. Absent (legacy/local default) = local. */
  source: RuleSetSourceSchema.optional(),
  /** Maps to mihomo's rule-provider `format:`. `mrs` is remote-only (binary). */
  format: RuleSetFormatSchema,
  /** Maps to mihomo's rule-provider `behavior:`. */
  behavior: RuleSetBehaviorSchema.optional(),
  /** local only: served verbatim at /api/rule-providers/{token}/{name}. */
  content: z.string().max(MAX_RULESET_CONTENT, '规则集内容过大').default(''),
  /** remote only: the external URL mihomo fetches directly. */
  url: z.string().optional(),
  /** Emitted as the declaration's `interval:` (seconds). Defaults to a day at render. */
  interval: z.number().int().positive().optional(),
  /** Optional proxy/policy name used for the provider fetch (`proxy:`). */
  proxy: z.string().optional(),
  note: z.string().optional(),
  updated_at: z.number().int(),
});

interface RuleSetFields {
  source?: 'local' | 'remote';
  format?: 'yaml' | 'text' | 'mrs';
  content?: string;
  url?: string;
}

/**
 * Cross-field invariants, returned as a flat issue list so both the Zod
 * `.superRefine` (create) and the service layer (merged patch/replace) can
 * share one source of truth. Kept out of the base object so `.omit`/`.partial`
 * still work on `RuleSetSchema`.
 */
export function ruleSetIssues(v: RuleSetFields): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const source = v.source ?? 'local';
  if (source === 'remote') {
    if (!v.url || v.url.trim() === '') {
      issues.push({ path: 'url', message: 'remote 规则集必须提供 url' });
    }
  } else {
    if (v.format === 'mrs') {
      issues.push({ path: 'format', message: '本地托管不支持 mrs（二进制）格式，请用 yaml 或 text' });
    }
    if (v.content === undefined || v.content.trim() === '') {
      issues.push({ path: 'content', message: '本地规则集必须填写内容' });
    }
  }
  return issues;
}

export function assertRuleSetInvariants(v: RuleSetFields, ctx: z.RefinementCtx): void {
  for (const issue of ruleSetIssues(v)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] });
  }
}

export const RuleSetCreateSchema = RuleSetSchema.omit({ id: true, updated_at: true }).superRefine(
  assertRuleSetInvariants,
);
/**
 * P1-5: optional fields accept `null` to CLEAR them. The client used to send
 * `undefined` for an emptied field, which `JSON.stringify` drops entirely, so
 * the service merge kept the old value ("save succeeds but nothing changed, the
 * button stays lit forever"). Sending an explicit `null` lets patchRuleSet
 * delete the field. `behavior`/`interval` are enum/number so an empty string
 * can't express "cleared" — null is the signal.
 */
export const RuleSetUpdateSchema = RuleSetSchema.omit({ id: true, updated_at: true })
  .partial()
  .extend({
    behavior: RuleSetBehaviorSchema.nullable().optional(),
    interval: z.number().int().positive().nullable().optional(),
    proxy: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  });

/**
 * The list-view shape: everything except `content`. Content is stored in its
 * own Redis key and only the `[id]` detail endpoint returns it — list payloads
 * stay small no matter how big the hosted bodies grow.
 */
export const RuleSetMetaSchema = RuleSetSchema.omit({ content: true });

export type RuleSet = z.infer<typeof RuleSetSchema>;
export type RuleSetMeta = z.infer<typeof RuleSetMetaSchema>;
export type RuleSetFormat = z.infer<typeof RuleSetFormatSchema>;
export type RuleSetBehavior = z.infer<typeof RuleSetBehaviorSchema>;
export type RuleSetSource = z.infer<typeof RuleSetSourceSchema>;
export type RuleSetCreate = z.infer<typeof RuleSetCreateSchema>;
export type RuleSetUpdate = z.infer<typeof RuleSetUpdateSchema>;
