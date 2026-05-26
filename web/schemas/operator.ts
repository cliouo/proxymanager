import { z } from 'zod';

/**
 * Node-processing operators — Sub-Store calls these 节点操作.
 *
 * A subscription carries an ordered `operators` pipeline. At resolve time
 * (after the upstream is fetched + normalised, before caching is consulted
 * by downstream callers) the engine runs each enabled operator over the
 * parsed Clash proxy list, in array order. The result is what every
 * consumer sees: the sub-provider endpoint, collection expansion, preview.
 *
 * Each operator is a tagged object discriminated on `kind`, plus:
 *   - `id`       stable identity for React keys / reorder
 *   - `disabled` toggle a step off without deleting it
 *
 * Adding a new operator = add a branch here + a case in
 * `lib/proxies/operators.ts` + an editor in the pipeline workbench.
 */

/** Protocol types we can filter on — mirrors what `uriToClash` emits. */
export const PROXY_TYPES = [
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'snell',
  'anytls',
  'wireguard',
  'socks5',
  'http',
] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];

/** A pattern string that must compile as a JS RegExp. */
const regexPattern = z
  .string()
  .min(1, '正则不能为空')
  .refine(
    (p) => {
      try {
        new RegExp(p);
        return true;
      } catch {
        return false;
      }
    },
    { message: '不是合法的正则表达式' },
  );

/** Optional flag string limited to JS regex flags. */
const regexFlags = z
  .string()
  .regex(/^[gimsuy]*$/, '非法的正则 flag')
  .optional();

const idFields = {
  /** Stable id for list keys + reordering. Generated client-side. */
  id: z.string().min(1),
  /** When true the step is kept but skipped at apply time. */
  disabled: z.boolean().optional(),
};

const filterMode = z.enum(['keep', 'drop']);

/** 1 · 正则过滤 — keep/drop nodes whose name matches a regex. */
export const FilterRegexOpSchema = z.object({
  ...idFields,
  kind: z.literal('filter-regex'),
  mode: filterMode.default('keep'),
  pattern: regexPattern,
  flags: regexFlags,
});

/** 2 · 去除无用节点 — drop info/ad nodes (traffic/expiry/官网…). */
export const FilterUselessOpSchema = z.object({
  ...idFields,
  kind: z.literal('filter-useless'),
  /** Extra keyword/regex fragments appended to the built-in junk list. */
  extra: z.array(z.string()).default([]),
});

/** 3 · 正则重命名/删除 — replace matches in the name (empty replacement = delete). */
export const RenameRegexOpSchema = z.object({
  ...idFields,
  kind: z.literal('rename-regex'),
  pattern: regexPattern,
  replacement: z.string().default(''),
  flags: regexFlags,
});

/** 4 · 国旗 emoji — add a leading flag from the detected region, or strip it. */
export const FlagEmojiOpSchema = z.object({
  ...idFields,
  kind: z.literal('flag-emoji'),
  action: z.enum(['add', 'remove']).default('add'),
  /**
   * When adding flags, render Taiwan (TW) nodes with the 🇨🇳 China flag
   * instead of 🇹🇼. Sub-Store offers the same toggle. No effect on `remove`.
   */
  tw2cn: z.boolean().optional(),
});

/** 5 · 类型过滤 — keep/drop by protocol type. */
export const FilterTypeOpSchema = z.object({
  ...idFields,
  kind: z.literal('filter-type'),
  mode: filterMode.default('keep'),
  types: z.array(z.enum(PROXY_TYPES)).default([]),
});

/** 6 · 排序 — order nodes by name / type / server / region. */
export const SortOpSchema = z.object({
  ...idFields,
  kind: z.literal('sort'),
  by: z.enum(['name', 'type', 'server', 'region']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

/** 7 · 设置属性 — force udp / tfo / skip-cert-verify. Omitted = leave as-is. */
export const SetPropOpSchema = z.object({
  ...idFields,
  kind: z.literal('set-prop'),
  udp: z.boolean().optional(),
  tfo: z.boolean().optional(),
  skipCertVerify: z.boolean().optional(),
});

/** 8 · 处理重复节点 — dedup by name / server:port; drop or rename-with-index. */
export const DedupOpSchema = z.object({
  ...idFields,
  kind: z.literal('dedup'),
  by: z.enum(['name', 'server-port']).default('name'),
  action: z.enum(['drop', 'rename']).default('drop'),
});

/** 9 · 地区过滤 — keep/drop by detected region code (HK/JP/US…). */
export const FilterRegionOpSchema = z.object({
  ...idFields,
  kind: z.literal('filter-region'),
  mode: filterMode.default('keep'),
  regions: z.array(z.string()).default([]),
});

export const OperatorSchema = z.discriminatedUnion('kind', [
  FilterRegexOpSchema,
  FilterUselessOpSchema,
  RenameRegexOpSchema,
  FlagEmojiOpSchema,
  FilterTypeOpSchema,
  SortOpSchema,
  SetPropOpSchema,
  DedupOpSchema,
  FilterRegionOpSchema,
]);

export const OperatorListSchema = z.array(OperatorSchema);

export type Operator = z.infer<typeof OperatorSchema>;
export type OperatorKind = Operator['kind'];
export type FilterMode = z.infer<typeof filterMode>;
