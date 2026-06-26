import { z } from 'zod';

/**
 * A managed mihomo `proxy-group`. Lifted out of the base.yaml `proxy-groups:`
 * block and stored in the `proxy-groups` Redis hash so the UI can edit groups
 * one-at-a-time without round-tripping the whole YAML, and so the engine can
 * cheaply detect cross-resource references (rule policies, dialer-proxy
 * chains, template merges).
 *
 * Field coverage mirrors mihomo's native proxy-group schema verbatim — every
 * vanilla field is here under its original kebab-case name, kept optional so
 * legacy/imported records and minimalist user input both parse. Project-only
 * metadata lives alongside (id/kind/template_id/section/rank/notes/...).
 *
 *   - `kind` is intent, not behaviour. The renderer treats every kind the
 *     same; the field exists so preset forms (E3) can map back to their
 *     editor UI without sniffing fields. `raw` is the escape hatch.
 *   - `template_id` opt-in shared defaults. At render time the template's
 *     fields are merged underneath the group's own fields (group wins,
 *     template fills gaps). One-way: editing a group never writes back to
 *     its template.
 *   - `rank` controls the order within the rendered `proxy-groups:` block.
 *     Migration assigns ranks in encounter order; subsequent edits inherit.
 *   - `section` is a UI hint carrying the nearest preceding section-header
 *     comment captured during migration ("# === 国家/地区 ===" → "国家/地区").
 *     Comments don't survive a YAML round-trip so we lift them into a field.
 */

export const ProxyGroupTypeSchema = z.enum([
  'select',
  'url-test',
  'fallback',
  'load-balance',
  'relay',
]);

/**
 * Subset of `proxy-group.type` that performs health-checking and therefore
 * accepts the `url`/`interval`/`tolerance`/`lazy`/`expected-status` fields.
 * Used by validators; not stored.
 */
export const HEALTH_CHECK_TYPES = ['url-test', 'fallback', 'load-balance'] as const;

/**
 * The mihomo native fields, all optional so they can either come from the
 * group directly or be filled in by a referenced template at render time.
 * `name` and `type` are required at the resolved level — required here too
 * because every well-formed group has them.
 *
 * Field names are kebab-case to match mihomo verbatim (no rename layer).
 */
const ProxyGroupNativeShape = {
  name: z.string().min(1),
  type: ProxyGroupTypeSchema,

  /** Explicit member list — proxy names, other proxy-group names, or built-ins (DIRECT/REJECT/...). */
  proxies: z.array(z.string()).optional(),
  /** Pull members from these proxy-providers by name. */
  use: z.array(z.string()).optional(),
  /** Pull from every proxy-provider. */
  'include-all-providers': z.boolean().optional(),
  /** Pull from every entry in the top-level `proxies:` block. */
  'include-all-proxies': z.boolean().optional(),
  /** include-all-proxies + include-all-providers. */
  'include-all': z.boolean().optional(),
  /** Regex applied to the resolved member set (post include/use/proxies). */
  filter: z.string().optional(),
  /** Inverse of `filter` — drop members whose name matches. */
  'exclude-filter': z.string().optional(),
  /** Drop members whose proxy `type` matches this comma-separated list (e.g. "Direct,Reject"). */
  'exclude-type': z.string().optional(),

  /** Health-check probe URL. Applies to url-test / fallback / load-balance. */
  url: z.string().optional(),
  /** Health-check interval in seconds. */
  interval: z.number().int().positive().optional(),
  /** url-test only — RTT difference (ms) before the current best is replaced. */
  tolerance: z.number().int().nonnegative().optional(),
  /** Defer the first probe until the group is actually selected. */
  lazy: z.boolean().optional(),
  /** Health-check expected status, e.g. "200" or "200-299". */
  'expected-status': z.string().optional(),
  /** Health-check failure threshold before a node is marked unhealthy. */
  'max-failed-times': z.number().int().positive().optional(),
  /** Health-check request timeout in ms. */
  timeout: z.number().int().positive().optional(),

  /** load-balance only — `consistent-hashing` | `round-robin` | `sticky-sessions`. */
  strategy: z.string().optional(),
  /** Route the group's own traffic through this dialer-proxy (used by the chained-proxy scenario). */
  'dialer-proxy': z.string().optional(),
  /** Linux SO_MARK passed by the kernel. Rarely set from the UI. */
  'routing-mark': z.number().int().optional(),
  /** Drop UDP support across the group. */
  'disable-udp': z.boolean().optional(),
  /** Hide the group from the dashboard / API. */
  hidden: z.boolean().optional(),
  /** Group icon URL — surfaced in some clients. */
  icon: z.string().optional(),
};

/**
 * `kind` encodes the group's **form** — how its members are sourced —
 * not its purpose. Purpose ("规则集出口 / 系统兜底 / 地区池 / 入口 …") lives
 * on the free-text `section` field so a single 8-way enum doesn't conflate
 * two orthogonal axes (the way the original taxonomy did).
 *
 *   - 'manual'     : 手选 — `proxies` list of named picks, no include-all
 *   - 'filter'     : 筛选 — `include-all-proxies` + `filter`(可加 manual 补充)
 *   - 'all'        : 全部 — `include-all-proxies`,无 filter
 *   - 'single-sub' : 绑定一个订阅源,`proxies` 渲染时填为该源存活节点名(不派生 filter)
 *   - 'raw'        : 逃生口
 *
 * Legacy values (`region`/`service`/`system`/`rule-set-policy`/`collection-scope`/
 * `all-auto-pair`) are accepted at parse time and transparently mapped to
 * the new form — so a brief data/schema deploy ordering can't drop records.
 * `scripts/recategorize-proxy-groups.ts` rewrites storage to the new values
 * and fills `section` from a rule reverse-lookup; after it runs no legacy
 * value remains in Redis.
 */
const NEW_KIND_VALUES = ['raw', 'manual', 'filter', 'all', 'single-sub'] as const;
const NewKindsEnum = z.enum(NEW_KIND_VALUES);

const LEGACY_KIND_REMAP: Record<string, z.infer<typeof NewKindsEnum>> = {
  region: 'filter',
  service: 'filter',
  system: 'manual',
  'rule-set-policy': 'manual',
  'collection-scope': 'manual',
  'all-auto-pair': 'manual',
};

export const ProxyGroupKindSchema = z
  .string()
  .transform((s) => LEGACY_KIND_REMAP[s] ?? s)
  .pipe(NewKindsEnum);

export type ProxyGroupKind = z.infer<typeof ProxyGroupKindSchema>;
export type ProxyGroupType = z.infer<typeof ProxyGroupTypeSchema>;

export const ProxyGroupSchema = z.object({
  id: z.uuid(),
  kind: ProxyGroupKindSchema.default('raw'),
  /** Optional shared-defaults template id. Template fields merge underneath the group's own fields. */
  template_id: z.uuid().optional(),
  /**
   * `kind: single-sub` binding — the subscription whose nodes this group
   * lists. At resolve time, the group's `proxies` is set to the bound sub's
   * surviving (post-injection) node names, overriding any user-typed
   * proxies/filter (node names are no longer prefixed, so there is no
   * `node_prefix`-derived filter). Ignored when `kind != single-sub`.
   * See resolve.ts (single-sub branch).
   */
  bound_subscription_id: z.uuid().optional(),
  /**
   * Deprecated `collection-scope` binding — the Collection whose members
   * this group's `proxies:` field listed. The `kind` enum no longer carries
   * `collection-scope` (schema preprocess maps it to `manual`), but a stale
   * pre-migration `bound_collection_id` is still tolerated: at resolve time
   * `proxies` is rebuilt from the collection's member subs' surviving node
   * names. Not settable via the AI tools or current UI.
   */
  bound_collection_id: z.uuid().optional(),
  /** UI grouping hint, e.g. "国家/地区". Not rendered. */
  section: z.string().optional(),
  /** Render order within `proxy-groups:`. Lower first. */
  rank: z.number().int().nonnegative(),
  /** Free-form note (origin tag from migration, user remarks, etc). */
  notes: z.string().optional(),
  created_at: z.number().int().optional(),
  updated_at: z.number().int(),
  ...ProxyGroupNativeShape,
});

export type ProxyGroup = z.infer<typeof ProxyGroupSchema>;

export const ProxyGroupCreateSchema = z
  .object({
    kind: ProxyGroupKindSchema.default('raw'),
    template_id: z.uuid().optional(),
    bound_subscription_id: z.uuid().optional(),
    bound_collection_id: z.uuid().optional(),
    section: z.string().optional(),
    rank: z.number().int().nonnegative().optional(),
    notes: z.string().optional(),
    ...ProxyGroupNativeShape,
  });

export const ProxyGroupUpdateSchema = z
  .object({
    kind: ProxyGroupKindSchema.optional(),
    template_id: z.uuid().nullable().optional(),
    bound_subscription_id: z.uuid().nullable().optional(),
    bound_collection_id: z.uuid().nullable().optional(),
    section: z.string().nullable().optional(),
    rank: z.number().int().nonnegative().optional(),
    notes: z.string().nullable().optional(),
    name: z.string().min(1).optional(),
    type: ProxyGroupTypeSchema.optional(),
    proxies: z.array(z.string()).optional(),
    use: z.array(z.string()).optional(),
    'include-all-providers': z.boolean().optional(),
    'include-all-proxies': z.boolean().optional(),
    'include-all': z.boolean().optional(),
    // String fields accept `null` to *clear* them — patchProxyGroup deletes the
    // key on null. (Metadata fields below do the same.)
    filter: z.string().nullable().optional(),
    'exclude-filter': z.string().nullable().optional(),
    'exclude-type': z.string().nullable().optional(),
    url: z.string().optional(),
    interval: z.number().int().positive().optional(),
    tolerance: z.number().int().nonnegative().optional(),
    lazy: z.boolean().optional(),
    'expected-status': z.string().optional(),
    'max-failed-times': z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    strategy: z.string().optional(),
    'dialer-proxy': z.string().nullable().optional(),
    'routing-mark': z.number().int().optional(),
    'disable-udp': z.boolean().optional(),
    hidden: z.boolean().optional(),
    icon: z.string().optional(),
  });

/**
 * Create-input type. Uses `z.input` (not `z.infer`) so callers can omit
 * fields that carry a `.default(...)` — most notably `kind`, which Zod 4
 * promotes to required in the *output* type because the default makes it
 * non-optional post-parse.
 */
export type ProxyGroupCreate = z.input<typeof ProxyGroupCreateSchema>;
export type ProxyGroupUpdate = z.infer<typeof ProxyGroupUpdateSchema>;

/* ─── Templates ─────────────────────────────────────────────────────── */

/**
 * Shared defaults for a family of groups — the moral equivalent of the
 * `&pr` YAML anchor in hand-written base.yaml. A template carries a strict
 * subset of native proxy-group fields (no `name`, no `proxies`, no
 * `kind`-style metadata). At render time, every group that references this
 * template inherits any field the group itself leaves unset.
 *
 * Templates are decoupled from groups by name + id. Renaming a template is
 * a metadata-only operation; groups never need to be rewritten.
 */
const ProxyGroupTemplateFieldsShape = {
  /** Default type for groups using this template (typically `url-test`). */
  type: ProxyGroupTypeSchema.optional(),
  url: z.string().optional(),
  interval: z.number().int().positive().optional(),
  tolerance: z.number().int().nonnegative().optional(),
  lazy: z.boolean().optional(),
  'expected-status': z.string().optional(),
  'max-failed-times': z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
  'disable-udp': z.boolean().optional(),
  hidden: z.boolean().optional(),
  'include-all-providers': z.boolean().optional(),
  'include-all-proxies': z.boolean().optional(),
  'include-all': z.boolean().optional(),
  'exclude-filter': z.string().optional(),
  'exclude-type': z.string().optional(),
  strategy: z.string().optional(),
  'dialer-proxy': z.string().optional(),
  'routing-mark': z.number().int().optional(),
  icon: z.string().optional(),
};

export const ProxyGroupTemplateSchema = z.object({
  id: z.uuid(),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'must contain only lowercase letters, digits, underscores, or dashes'),
  notes: z.string().optional(),
  updated_at: z.number().int(),
  ...ProxyGroupTemplateFieldsShape,
});

export type ProxyGroupTemplate = z.infer<typeof ProxyGroupTemplateSchema>;

export const ProxyGroupTemplateCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'must contain only lowercase letters, digits, underscores, or dashes'),
  notes: z.string().optional(),
  ...ProxyGroupTemplateFieldsShape,
});

export const ProxyGroupTemplateUpdateSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'must contain only lowercase letters, digits, underscores, or dashes')
    .optional(),
  notes: z.string().nullable().optional(),
  type: ProxyGroupTypeSchema.optional(),
  url: z.string().optional(),
  interval: z.number().int().positive().optional(),
  tolerance: z.number().int().nonnegative().optional(),
  lazy: z.boolean().optional(),
  'expected-status': z.string().optional(),
  'max-failed-times': z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
  'disable-udp': z.boolean().optional(),
  hidden: z.boolean().optional(),
  'include-all-providers': z.boolean().optional(),
  'include-all-proxies': z.boolean().optional(),
  'include-all': z.boolean().optional(),
  'exclude-filter': z.string().optional(),
  'exclude-type': z.string().optional(),
  strategy: z.string().optional(),
  'dialer-proxy': z.string().optional(),
  'routing-mark': z.number().int().optional(),
  icon: z.string().optional(),
});

export type ProxyGroupTemplateCreate = z.infer<typeof ProxyGroupTemplateCreateSchema>;
export type ProxyGroupTemplateUpdate = z.infer<typeof ProxyGroupTemplateUpdateSchema>;

/**
 * Names of proxy-groups that serve purely as a chained-proxy *front pool* — a
 * group that some other group points at via `dialer-proxy`. These are internal
 * plumbing (a chain dials *through* them; routing traffic straight at one only
 * reaches the front, not the backend), so they should not be offered as rule
 * policies or as members of other groups. Detection is structural
 * (rename-proof), not by the `pool:` name convention.
 */
export function frontPoolGroupNames(
  groups: Array<{ name: string; 'dialer-proxy'?: string | null }>,
): Set<string> {
  const groupNames = new Set(groups.map((g) => g.name));
  const pools = new Set<string>();
  for (const g of groups) {
    const dp = g['dialer-proxy'];
    if (dp && groupNames.has(dp)) pools.add(dp);
  }
  return pools;
}

/* ─── Render-time merge ──────────────────────────────────────────────── */

/**
 * Fields that participate in template merging. Order matches mihomo's
 * native order (roughly): identity, member-resolution, health-check,
 * routing, presentation. Used by the renderer to compose the final group
 * map before emit.
 */
export const TEMPLATE_MERGE_FIELDS = [
  'type',
  'url',
  'interval',
  'tolerance',
  'lazy',
  'expected-status',
  'max-failed-times',
  'timeout',
  'disable-udp',
  'hidden',
  'include-all-providers',
  'include-all-proxies',
  'include-all',
  'exclude-filter',
  'exclude-type',
  'strategy',
  'dialer-proxy',
  'routing-mark',
  'icon',
] as const;

/**
 * Merge a group's own fields on top of an optional template — the group
 * always wins for any field it sets; the template fills gaps.
 *
 * Identity / member-list fields (`name`, `proxies`, `use`, `filter`) are
 * group-only and never come from the template, even if the template
 * happens to declare them.
 */
export function mergeWithTemplate(
  group: ProxyGroup,
  template: ProxyGroupTemplate | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: group.name,
    type: group.type,
  };

  // Template fills gaps (group wins on every field it sets).
  for (const field of TEMPLATE_MERGE_FIELDS) {
    const groupValue = (group as Record<string, unknown>)[field];
    if (groupValue !== undefined) {
      out[field] = groupValue;
      continue;
    }
    if (template) {
      const tplValue = (template as Record<string, unknown>)[field];
      if (tplValue !== undefined) out[field] = tplValue;
    }
  }

  // Member-resolution fields are group-only.
  if (group.proxies !== undefined) out.proxies = group.proxies;
  if (group.use !== undefined) out.use = group.use;
  if (group.filter !== undefined) out.filter = group.filter;

  return out;
}
