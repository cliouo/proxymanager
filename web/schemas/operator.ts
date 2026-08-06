import { z } from '@/lib/openapi/zod';
import {
  LEGACY_DEFAULT_COMPONENTS,
  MAX_RECOGNITION_RULES,
  MAX_RECOGNITION_RULE_PATTERN_LENGTH,
  MAX_RECOGNITION_RULE_VALUE_LENGTH,
  MAX_TEMPLATE_LENGTH,
  templateFromLegacyConfig,
  validateTemplate,
} from '@/lib/proxies/naming';
import { isSafeRuntimeRegex, MAX_RUNTIME_REGEX_PATTERN_LENGTH } from '@/lib/proxies/regexSafety';

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

/** A bounded pattern string; each operator schema checks it with its actual flags. */
const regexPattern = z
  .string()
  .min(1, '正则不能为空')
  .max(MAX_RUNTIME_REGEX_PATTERN_LENGTH, '正则过长')
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

/**
 * A single `filter-useless` extra fragment. Beyond compiling as a RegExp it
 * must NOT match the empty string: fragments like `a|`, `|`, `.*` or `(?:)`
 * are joined into the junk pattern with `|`, and an empty-matching branch there
 * makes the whole regex match every node name → the operator silently drops
 * ALL nodes (and a bare `(` used to throw at RegExp construction, 500-ing every
 * profile bound to the aggregate). See P0-5.
 */
const uselessExtraPattern = regexPattern
  .refine(
    (p) => {
      try {
        return !new RegExp(p).test('');
      } catch {
        return false;
      }
    },
    { message: '过滤片段不能匹配空串（会误删全部节点），也不能是空分支如 "a|"' },
  )
  .refine((p) => isSafeRuntimeRegex(p, 'i'), { message: '正则可能导致过量回溯，已拒绝' });

/** Optional flag string limited to JS regex flags. */
const regexFlags = z
  .string()
  .max(6, '正则 flag 过长')
  .regex(/^[gimsuy]*$/, '非法的正则 flag')
  .refine((flags) => new Set(flags).size === flags.length, '正则 flag 不能重复')
  .optional();

const idFields = {
  /** Stable id for list keys + reordering. Generated client-side. */
  id: z.string().min(1).max(128),
  /** When true the step is kept but skipped at apply time. */
  disabled: z.boolean().optional(),
};

const filterMode = z.enum(['keep', 'drop']);

/** 1 · 正则过滤 — keep/drop nodes whose name matches a regex. */
export const FilterRegexOpSchema = z
  .object({
    ...idFields,
    kind: z.literal('filter-regex'),
    mode: filterMode.default('keep'),
    pattern: regexPattern,
    flags: regexFlags,
  })
  .superRefine((value, ctx) => {
    if (!isSafeRuntimeRegex(value.pattern, value.flags ?? 'i')) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: '正则可能导致过量回溯，已拒绝',
      });
    }
  });

/** 2 · 去除无用节点 — drop info/ad nodes (traffic/expiry/官网…). */
export const FilterUselessOpSchema = z.object({
  ...idFields,
  kind: z.literal('filter-useless'),
  /** Extra keyword/regex fragments appended to the built-in junk list. */
  extra: z.array(uselessExtraPattern).max(32).default([]),
});

/** 3 · 正则重命名/删除 — replace matches in the name (empty replacement = delete). */
export const RenameRegexOpSchema = z
  .object({
    ...idFields,
    kind: z.literal('rename-regex'),
    pattern: regexPattern,
    replacement: z.string().max(512).default(''),
    flags: regexFlags,
  })
  .superRefine((value, ctx) => {
    if (!isSafeRuntimeRegex(value.pattern, value.flags ?? 'g')) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: '正则可能导致过量回溯，已拒绝',
      });
    }
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

/* ─── 10 · 名称统一（模板命名） — placeholder-template DSL ──────────── */

/**
 * The placeholder template is the PERSISTED SOURCE OF TRUTH for managed
 * naming. Grammar + bounds are enforced by the shared compiler
 * (lib/proxies/naming.ts): `${field}`, `${field:mod}`, `${?field: content}`
 * optional segments, `$$` literal escape. Closed whitelist of fields:
 * emoji · region · region_code · entry · route · vendor · source · protocol ·
 * rate · index · note. No eval, loops or arbitrary code exist in the grammar.
 */
export const NamingTemplateSchema = z
  .string()
  .min(1, '模板不能为空')
  .max(MAX_TEMPLATE_LENGTH, `模板过长（最多 ${MAX_TEMPLATE_LENGTH} 字符）`)
  .superRefine((template, ctx) => {
    const validation = validateTemplate(template);
    if (!validation.ok) {
      ctx.addIssue({ code: 'custom', message: validation.message });
    }
  });

/**
 * Saved, validated recognition override (AI-rule facts). A rule that matches
 * the node name deterministically overrides one semantic field; it is a
 * bounded pattern + bounded label — never code. AI-proposed rules become
 * runtime facts ONLY after this schema + the save gate validate them.
 */
export const RecognitionRuleSchema = z
  .object({
    pattern: z
      .string()
      .min(1, '规则正则不能为空')
      .max(MAX_RECOGNITION_RULE_PATTERN_LENGTH, '规则正则过长')
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
      ),
    field: z.enum(['route', 'vendor', 'region', 'entry']),
    value: z
      .string()
      .min(1, '规则值不能为空')
      .max(MAX_RECOGNITION_RULE_VALUE_LENGTH, '规则值过长（最多 24 字符）'),
  })
  .superRefine((rule, ctx) => {
    if (!isSafeRuntimeRegex(rule.pattern, 'i')) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: '正则可能导致过量回溯，已拒绝',
      });
    }
  });

export const RecognitionRulesSchema = z
  .array(RecognitionRuleSchema)
  .max(MAX_RECOGNITION_RULES, `识别规则最多 ${MAX_RECOGNITION_RULES} 条`)
  .default([]);

/* ─── legacy (pre-DSL) rename-template shapes — DECODE ONLY ────────── */

export const NamingPresetSchema = z.enum(['minimal', 'balanced', 'detailed', 'custom']);

export const NamingComponentsSchema = z.object({
  /** 国旗 emoji（与 flag-emoji 同表：REGIONS → emoji）。 */
  flag: z.boolean(),
  /** 地区标签（中文名或 alpha-2 代码）。 */
  region: z.boolean(),
  /** 入口 / 中转 / 落地等路由提示（仅保守词表命中时输出）。 */
  route: z.boolean(),
  /** 服务商 / 机场提示（仅保守词表命中时输出）。 */
  vendor: z.boolean(),
  /** 协议 / 技术（节点结构化 type 字段）。 */
  protocol: z.boolean(),
  /** 倍率（默认省略 1x，见 rateDisplay）。 */
  rate: z.boolean(),
  /** 来源订阅别名（单订阅 = 自身别名；聚合 = 各成员别名）。 */
  source: z.boolean(),
  /** 按来源稳定的序号（01/02…）。 */
  index: z.boolean(),
});

export const RegionLabelSchema = z.enum(['zh', 'code']);
export const RateDisplaySchema = z.enum(['omit-1x', 'all']);
export const NamingSeparatorSchema = z.enum([' ', ' · ', ' | ']);

const SourceAliasesSchema = z
  .record(z.string(), z.string().min(1).max(40, '来源别名过长'))
  .optional()
  .refine((v) => v === undefined || Object.keys(v).length <= 64, {
    message: '来源别名表过大（最多 64 项）',
  });

/** Legacy keys a write must never mix with the template (ambiguous dual config). */
const LEGACY_RENAME_TEMPLATE_KEYS = [
  'preset',
  'components',
  'regionLabel',
  'rateDisplay',
  'separator',
] as const;

/**
 * The rename-template shape WITHOUT the dual-config rejection/strip — used by
 * the AI action layer (which materialises through OperatorSchema anyway) and
 * as the base for the write schema below.
 */
export const RenameTemplateOpFieldsSchema = z.object({
  ...idFields,
  kind: z.literal('rename-template'),
  template: NamingTemplateSchema,
  /** 台湾节点用中国旗（与 flag-emoji 的 tw2cn 同一语义）。 */
  tw2cn: z.boolean().optional(),
  /** 手工别名覆盖：键为订阅源 slug（name），值为展示别名。 */
  sourceAliases: SourceAliasesSchema,
  /** 保存并经校验的识别规则（AI-rule 事实；见 RecognitionRuleSchema）。 */
  recognitionRules: RecognitionRulesSchema,
});

/**
 * 10 · 名称统一 — compose each node's name from a bounded placeholder
 * template (lib/proxies/naming.ts). Deterministic after save: the executor
 * never calls out to a model; the AI analysis only suggests a template.
 *
 * The legacy preset/components/regionLabel/rateDisplay/separator fields are
 * READ-ONLY historical data (projected to an equivalent template by the
 * stored decoder). Current writes MUST NOT mix them with `template` — that
 * dual configuration is rejected so the persisted source of truth is always
 * unambiguous.
 */
export const RenameTemplateOpSchema = RenameTemplateOpFieldsSchema.passthrough()
  .superRefine((value, ctx) => {
    // Reject ambiguous dual configuration: legacy component fields must not
    // ride along with the template (they would be silently ignored otherwise).
    const legacy = LEGACY_RENAME_TEMPLATE_KEYS.find((key) => key in value);
    if (legacy !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [legacy],
        message: '旧版成分配置已由模板（template）取代，不能与模板同时提交',
      });
    }
  })
  .transform((value) => {
    // Strip any legacy keys that rode in — the template is the only source of
    // truth in the persisted row.
    const rest = { ...value };
    for (const key of LEGACY_RENAME_TEMPLATE_KEYS) delete rest[key];
    return rest;
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
  RenameTemplateOpSchema,
]);

/**
 * A pipeline may contain at most one rename-template step. Enforced at the
 * LIST level so every save/preview path shares the same rule and gets an
 * actionable path pointing at the offending step.
 */
function assertSingleRenameTemplate(value: Operator[], ctx: z.RefinementCtx): void {
  const indexes = value
    .map((op, i) => (op.kind === 'rename-template' ? i : -1))
    .filter((i) => i >= 0);
  if (indexes.length <= 1) return;
  ctx.addIssue({
    code: 'custom',
    path: [indexes[1], 'kind'],
    message: '一个处理流程只能有一个「名称统一（模板命名）」步骤',
  });
}

/**
 * The managed rename-template is the FINAL rename stage: no enabled
 * rename-capable step (rename-regex with a pattern, flag-emoji) may run
 * AFTER it, or the managed output would be renamed a second time. Filters /
 * dedup / sort / set-prop / filter-useless stay available and ordered on
 * either side. Disabled steps never run and are not rejected.
 */
function assertRenameTemplateIsFinalRename(value: Operator[], ctx: z.RefinementCtx): void {
  let managedSeen = false;
  value.forEach((op, i) => {
    if (op.disabled) return;
    if (op.kind === 'rename-template') {
      managedSeen = true;
      return;
    }
    if (!managedSeen) return;
    if (op.kind === 'rename-regex' && op.pattern && op.pattern.trim() !== '') {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'kind'],
        message:
          '「名称统一」是最终改名阶段：它之后的 rename-regex 会二次改名，已拒绝。请把它移到「名称统一」之前。',
      });
    } else if (op.kind === 'flag-emoji') {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'kind'],
        message:
          '「名称统一」是最终改名阶段：它之后的 flag-emoji 会二次改名，已拒绝。请把它移到「名称统一」之前。',
      });
    }
  });
}

/**
 * React keys + the workbench's stepById map require unique operator ids — a
 * duplicate id makes cards collide and traces misalign, so current writes
 * reject it with an actionable path.
 */
function assertUniqueOperatorIds(value: Operator[], ctx: z.RefinementCtx): void {
  const seen = new Map<string, number>();
  value.forEach((op, i) => {
    const prev = seen.get(op.id);
    if (prev !== undefined) {
      ctx.addIssue({ code: 'custom', path: [i, 'id'], message: '算子 id 重复' });
    } else {
      seen.set(op.id, i);
    }
  });
}

/**
 * Current (write/preview) operator lists — max 64 steps, at most one
 * rename-template, unique ids. Used by preview endpoints and every
 * create/update schema.
 */
export const OperatorListSchema = z
  .array(OperatorSchema)
  .max(64)
  .superRefine(assertSingleRenameTemplate)
  .superRefine(assertRenameTemplateIsFinalRename)
  .superRefine(assertUniqueOperatorIds);

/**
 * EXTERNAL MUTATION lists (pass-8 blocker 2): generic add/update/delete/
 * reorder surfaces may carry EXISTING rename-template rows — the CURRENT-vs-
 * CANDIDATE invariant policy at the service boundary
 * (operatorMutationPolicy) rejects creation/touch/delete/move of a naming
 * row with one bounded dedicated-gate error before any write/audit, while
 * key-order-only candidates are semantically equal and inserting/deleting a
 * non-name row before the naming row (a numeric index shift, not a move) is
 * allowed. The profile-bound naming apply service (save_naming_plan / the
 * 智能命名 workspace route) remains the ONLY rename-template mutation path
 * with its confirmation, version + membership bracket, history, rollback,
 * CAS and atomic exactly-one-audit.
 */
export const MutableOperatorListSchema = OperatorListSchema;

/**
 * Decoder for operators already stored before the runtime-safety limits above
 * were introduced. Persisted rows must remain visible/editable after an
 * upgrade, but an operator that no longer satisfies the write/runtime schema
 * must never execute. Decode the historical structural contract, then park
 * incompatible steps by forcing `disabled` and exposing a fixed diagnostic
 * code (never the regex itself) to management clients.
 */
const storedRegexPattern = z
  .string()
  .min(1, '正则不能为空')
  .refine(
    (pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: '不是合法的正则表达式' },
  );

const storedUselessExtraPattern = storedRegexPattern.refine(
  (pattern) => {
    try {
      return !new RegExp(pattern).test('');
    } catch {
      return false;
    }
  },
  { message: '过滤片段不能匹配空串（会误删全部节点），也不能是空分支如 "a|"' },
);

const storedRegexFlags = z
  .string()
  .regex(/^[gimsuy]*$/, '非法的正则 flag')
  .optional();
const storedIdFields = {
  id: z.string().min(1),
  disabled: z.boolean().optional(),
};

const HistoricalOperatorSchema = z.discriminatedUnion('kind', [
  z.object({
    ...storedIdFields,
    kind: z.literal('filter-regex'),
    mode: filterMode.default('keep'),
    pattern: storedRegexPattern,
    flags: storedRegexFlags,
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('filter-useless'),
    extra: z.array(storedUselessExtraPattern).default([]),
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('rename-regex'),
    pattern: storedRegexPattern,
    replacement: z.string().default(''),
    flags: storedRegexFlags,
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('flag-emoji'),
    action: z.enum(['add', 'remove']).default('add'),
    tw2cn: z.boolean().optional(),
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('filter-type'),
    mode: filterMode.default('keep'),
    types: z.array(z.enum(PROXY_TYPES)).default([]),
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('sort'),
    by: z.enum(['name', 'type', 'server', 'region']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('set-prop'),
    udp: z.boolean().optional(),
    tfo: z.boolean().optional(),
    skipCertVerify: z.boolean().optional(),
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('dedup'),
    by: z.enum(['name', 'server-port']).default('name'),
    action: z.enum(['drop', 'rename']).default('drop'),
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('filter-region'),
    mode: filterMode.default('keep'),
    regions: z.array(z.string()).default([]),
  }),
  z.object({
    ...storedIdFields,
    kind: z.literal('rename-template'),
    // Legacy (pre-DSL) shape — decode only. New-shape rows carry `template`.
    preset: NamingPresetSchema.default('balanced'),
    components: NamingComponentsSchema.default(LEGACY_DEFAULT_COMPONENTS),
    regionLabel: RegionLabelSchema.default('zh'),
    rateDisplay: RateDisplaySchema.default('omit-1x'),
    separator: NamingSeparatorSchema.default(' · '),
    tw2cn: z.boolean().optional(),
    // New-shape rows (post-DSL): template + recognitionRules.
    template: z.string().optional(),
    recognitionRules: z.array(z.unknown()).optional(),
    // STRUCTURAL historical decode: no current limits (an oversized alias
    // table stays a KNOWN step — the runtime schema below parks it with
    // fields preserved instead of degrading it to a generic malformed blob).
    sourceAliases: z.record(z.string(), z.string()).optional(),
  }),
]);

export const STORED_OPERATOR_COMPATIBILITY_ISSUE = 'runtime-validation-required' as const;
export const STORED_OPERATOR_DUPLICATE_ISSUE = 'duplicate-rename-template' as const;
export const STORED_OPERATOR_UNKNOWN_KIND_ISSUE = 'unknown-operator-kind' as const;
export const STORED_OPERATOR_MALFORMED_ISSUE = 'malformed-operator' as const;

/**
 * Non-executable diagnostic placeholder for a persisted step that cannot be
 * decoded at all (unknown kind / malformed shape). Keeps the step's ARRAY
 * POSITION so the rest of the pipeline stays in its stored order, carries a
 * fixed issue code, and NEVER echoes the raw stored fields (they may be
 * sensitive). Runtime-invalid but structurally-known steps instead stay
 * editable (see StoredOperatorSchema).
 */
export const PARKED_OPERATOR_KIND = '__incompatible__' as const;

export interface ParkedOperator {
  id: string;
  kind: typeof PARKED_OPERATOR_KIND;
  disabled: true;
  compatibility_issue: string;
}

const KNOWN_STORED_KINDS = new Set<unknown>([
  'filter-regex',
  'filter-useless',
  'rename-regex',
  'flag-emoji',
  'filter-type',
  'sort',
  'set-prop',
  'dedup',
  'filter-region',
  'rename-template',
]);

/** Diagnostic-only placeholder; id is ALWAYS synthetic from position — a raw
 * historical id may itself be secret-shaped and is never echoed. */
function parkedOperator(_item: unknown, index: number, issue: string): ParkedOperator {
  return {
    id: `parked-${index}`,
    kind: PARKED_OPERATOR_KIND,
    disabled: true,
    compatibility_issue: issue,
  };
}

interface StoredRenameTemplateRow {
  id: string;
  kind: 'rename-template';
  disabled?: boolean;
  preset?: string;
  components?: LegacyComponentsShape;
  regionLabel?: 'zh' | 'code';
  rateDisplay?: 'omit-1x' | 'all';
  separator?: ' ' | ' · ' | ' | ';
  tw2cn?: boolean;
  template?: string;
  sourceAliases?: Record<string, string>;
  recognitionRules?: unknown;
}

interface LegacyComponentsShape {
  flag: boolean;
  region: boolean;
  route: boolean;
  vendor: boolean;
  protocol: boolean;
  rate: boolean;
  source: boolean;
  index: boolean;
}

/**
 * Deterministic compatibility migration for a STORED rename-template row:
 *   - a new-shape row (with `template`) is used as-is — the template is the
 *     source of truth (dual-config rows: template wins, legacy ignored);
 *   - a legacy row (preset/components/regionLabel/rateDisplay/separator) is
 *     projected to an EQUIVALENT template via templateFromLegacyConfig;
 *   - the persisted raw bytes are never rewritten — restoreRawOperators
 *     keeps the legacy row byte-for-byte until the user explicitly saves.
 */
function migrateStoredRenameTemplate(row: StoredRenameTemplateRow): {
  id: string;
  kind: 'rename-template';
  template: string;
  disabled?: boolean;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: unknown;
} {
  const { id, kind, disabled, template, tw2cn, sourceAliases, recognitionRules } = row;
  if (typeof template === 'string' && template.trim() !== '') {
    return { id, kind, template, disabled, tw2cn, sourceAliases, recognitionRules };
  }
  const projected = templateFromLegacyConfig({
    preset: row.preset ?? 'balanced',
    components: {
      flag: row.components?.flag ?? LEGACY_DEFAULT_COMPONENTS.flag,
      region: row.components?.region ?? LEGACY_DEFAULT_COMPONENTS.region,
      route: row.components?.route ?? LEGACY_DEFAULT_COMPONENTS.route,
      vendor: row.components?.vendor ?? LEGACY_DEFAULT_COMPONENTS.vendor,
      protocol: row.components?.protocol ?? LEGACY_DEFAULT_COMPONENTS.protocol,
      rate: row.components?.rate ?? LEGACY_DEFAULT_COMPONENTS.rate,
      source: row.components?.source ?? LEGACY_DEFAULT_COMPONENTS.source,
      index: row.components?.index ?? LEGACY_DEFAULT_COMPONENTS.index,
    },
    regionLabel: row.regionLabel ?? 'zh',
    rateDisplay: row.rateDisplay ?? 'omit-1x',
    separator: row.separator ?? ' · ',
  });
  return { id, kind, template: projected, disabled, tw2cn, sourceAliases, recognitionRules };
}

/** Decode ONE persisted item; structurally-known + runtime-valid → live operator. */
function decodeStoredItem(item: unknown, index: number): StoredOperator {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return parkedOperator(item, index, STORED_OPERATOR_MALFORMED_ISSUE);
  }
  const record = item as {
    kind?: unknown;
    id?: unknown;
    disabled?: unknown;
    compatibility_issue?: unknown;
  };
  // Idempotency: an already-parked placeholder decodes to a FRESH synthetic
  // placeholder with the same issue code (never the raw object — extra fields
  // on a persisted `__incompatible__` row must not leak). The raw-
  // preservation equality check depends on this byte-stability.
  const parkedIssues: Record<string, true> = {
    [STORED_OPERATOR_UNKNOWN_KIND_ISSUE]: true,
    [STORED_OPERATOR_MALFORMED_ISSUE]: true,
  };
  const ownCompatibilityIssue = hasOwnCompatibilityIssue(record)
    ? record.compatibility_issue
    : undefined;
  const parkedCompatibilityIssue =
    typeof ownCompatibilityIssue === 'string' ? ownCompatibilityIssue : undefined;
  if (
    record.kind === PARKED_OPERATOR_KIND &&
    record.id === `parked-${index}` &&
    record.disabled === true &&
    parkedCompatibilityIssue !== undefined &&
    parkedIssues[parkedCompatibilityIssue] === true
  ) {
    return parkedOperator(undefined, index, parkedCompatibilityIssue);
  }
  const kind = record.kind;
  if (typeof kind !== 'string' || !KNOWN_STORED_KINDS.has(kind)) {
    return parkedOperator(item, index, STORED_OPERATOR_UNKNOWN_KIND_ISSUE);
  }
  const decoded = HistoricalOperatorSchema.safeParse(item);
  if (!decoded.success) {
    return parkedOperator(item, index, STORED_OPERATOR_MALFORMED_ISSUE);
  }
  // rename-template rows are migrated to the template DSL FIRST: the legacy
  // component shape decodes fine but must project to an equivalent template
  // before the CURRENT runtime schema can judge it.
  const candidate =
    decoded.data.kind === 'rename-template'
      ? migrateStoredRenameTemplate(decoded.data as unknown as StoredRenameTemplateRow)
      : decoded.data;
  const current = OperatorSchema.safeParse(candidate);
  if (!current.success) {
    // Historically valid shape, fails the CURRENT runtime schema — parked
    // disabled but kept editable (fields preserved so the user can fix it).
    // Union members don't carry compatibility_issue statically — the shape is
    // exactly the persisted parked form (fields kept editable, never executed).
    // For a migrated rename-template the preserved fields are the MIGRATED
    // template shape (the raw legacy row stays untouched in storage).
    return {
      ...candidate,
      disabled: true as const,
      compatibility_issue: STORED_OPERATOR_COMPATIBILITY_ISSUE,
    } as unknown as StoredOperator;
  }
  return current.data;
}

/**
 * Stored (persisted) operator lists — decoded PER ITEM: one unknown kind or
 * malformed row can never drop the whole subscription/collection. Valid steps
 * keep their exact stored order and execute as before; bad items become
 * fixed diagnostic placeholders at their original position; a duplicate
 * rename-template parks disabled (first one stays active). The 64-step cap
 * deliberately does NOT apply to stored rows (historical arrays may exceed it
 * and must still load); write/preview lists keep max 64 + uniqueness.
 */
export const StoredOperatorListSchema = z.array(z.unknown()).transform((items) => {
  const out: StoredOperator[] = [];
  // Round-9: only a CURRENT-VALID rename-template consumes the managed slot.
  // Uses hasOwnCompatibilityIssue (Object.hasOwn) — an inherited prototype
  // value/getter never demotes a valid row nor promotes a historical one.
  // A malformed/unknown (parked) or runtime-invalid rename-shaped row does
  // NOT — a valid rename-template later in the pipeline stays the logical
  // managed row, and only a SECOND current-valid rename-template is parked
  // as a duplicate.
  let seenRenameTemplate = false;
  items.forEach((item, index) => {
    const decoded = decodeStoredItem(item, index);
    if (isCurrentRenameTemplateOperator(decoded)) {
      if (seenRenameTemplate) {
        out.push({
          ...decoded,
          disabled: true as const,
          compatibility_issue: STORED_OPERATOR_DUPLICATE_ISSUE,
        } as RuntimeParkedOperator);
        return;
      }
      seenRenameTemplate = true;
    }
    out.push(decoded);
  });
  return out;
});

export type Operator = z.infer<typeof OperatorSchema>;

/**
 * A structurally-known stored step that fails the CURRENT runtime schema
 * (unsafe regex, oversized alias table, …). Kept visible + editable (fields
 * preserved); never executes; the save path re-validates and strips the
 * diagnostic field once the user's edit parses.
 */
export type RuntimeParkedOperator = Operator & {
  disabled: true;
  compatibility_issue: string;
};

export type StoredOperator = Operator | RuntimeParkedOperator | ParkedOperator;

/** True for the fixed diagnostic placeholder (never executable, never editable). */
export function isParkedOperator(op: StoredOperator): op is ParkedOperator {
  return op.kind === PARKED_OPERATOR_KIND;
}
/**
 * Round-9 shared own-property predicate: true only when the record carries an
 * own data-property `compatibility_issue` — uses Object.hasOwn and never reads
 * an inherited Object.prototype value or fires an inherited getter. An own
 * diagnostic field (string) classifies the record as historical / invalid;
 * inherited pollution is silently ignored.
 */
export function hasOwnCompatibilityIssue(
  value: unknown,
): value is { compatibility_issue: unknown } {
  if (value === null || typeof value !== 'object') return false;
  return Object.hasOwn(value as object, 'compatibility_issue');
}

/**
 * Round-9 strict current-valid rename-template check: the row is a non-parked
 * `rename-template` operator with NO own `compatibility_issue`. Uses
 * Object.hasOwn so an inherited prototype value/getter never demotes a valid
 * managed row nor promotes a historical one. This is the one predicate shared
 * across schema decode, snapshot classifier, mutation policy, naming apply,
 * save candidate, and client workbench — identical semantics everywhere.
 */
export function isCurrentRenameTemplateOperator(
  op: StoredOperator,
): op is Operator & { kind: 'rename-template' } {
  if (isParkedOperator(op)) return false;
  if (op.kind !== 'rename-template') return false;
  return !hasOwnCompatibilityIssue(op);
}

/** True for steps that may reach the engine (parked placeholders never run). */
export function isExecutableOperator(op: StoredOperator): op is Operator {
  return op.kind !== PARKED_OPERATOR_KIND;
}
export type OperatorKind = Operator['kind'];
export type RenameTemplateOp = z.infer<typeof RenameTemplateOpSchema>;
export type FilterMode = z.infer<typeof filterMode>;
