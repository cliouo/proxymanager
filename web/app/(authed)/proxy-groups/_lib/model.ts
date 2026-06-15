import type { ProxyGroup, ProxyGroupKind, ProxyGroupType } from '@/schemas';

/**
 * Shared client model for the 策略组 workspace.
 *
 * A proxy-group's membership comes from up to three composable sources:
 *   1. 手选  — explicit `proxies:` (builtins / other groups / individual nodes), ordered
 *   2. 自动纳入 — `include-all*` + `filter`/`exclude-filter`, with a live match preview
 *   3. 绑定  — render-time, kind-driven (single-sub → proxies from the bound
 *              sub's member nodes). Read-only preview.
 *
 * `kind` is a *soft lens*, not a locked mode: it decides which source the
 * editor foregrounds and any render-time binding — but every native field
 * stays reachable in the advanced drawer, so there's no one-way "转 raw" trap.
 */

/* ─── Lightweight cross-resource shapes the page hands down ───────────── */

export interface SubscriptionLite {
  id: string;
  name: string;
  display_name?: string;
  enabled: boolean;
  tags?: string[];
}

export interface CollectionLite {
  id: string;
  name: string;
  enabled?: boolean;
  subscription_ids: string[];
  subscription_tags: string[];
}

/* ─── Kind metadata ──────────────────────────────────────────────────── */

/**
 * `kind` 编码"成员怎么来"(形态),只有 5 种。**用途**("规则集出口 / 系统兜底 /
 * 地区池 / 入口")由 free-text `section` 字段单独承担——两个正交轴拆开就
 * 不会再有"规则集策略组 vs 系统组 vs 手选组"这种 8 选 1 的歧义。
 */
export const KIND_LABELS: Record<ProxyGroupKind, string> = {
  manual: '手选组',
  filter: '筛选组',
  all: '全部节点',
  'single-sub': '单订阅组',
  raw: '自由编辑(raw)',
};

/** 成员来源视角切换条的短标签(对齐原型 lensSeg:手选/正则筛选/全量/单订阅/原始字段)。 */
export const KIND_SEG_LABELS: Record<ProxyGroupKind, string> = {
  manual: '手选',
  filter: '正则筛选',
  all: '全量',
  'single-sub': '单订阅',
  raw: '原始字段',
};

export const KIND_DESCRIPTIONS: Record<ProxyGroupKind, string> = {
  manual: '从清单点选成员(内置 / 节点 / 其他策略组)。规则集出口、系统兜底常用此型。',
  filter: 'include-all-proxies + filter:按正则自动纳入节点(含地区快填)。',
  all: 'include-all-proxies + 无 filter:把全部节点都纳入(总开关)。',
  'single-sub': '绑定一个订阅源,渲染时成员 = 该源处理后的全部节点。',
  raw: '逐字段编辑 mihomo 原生 proxy-group(逃生口)。',
};

/** Order shown in the intent picker (most-used first; raw last as the escape hatch). */
export const KIND_ORDER: ProxyGroupKind[] = ['manual', 'filter', 'all', 'single-sub', 'raw'];

/** Commonly-used `section` values shown as a datalist in the editor. Free text otherwise. */
export const COMMON_SECTIONS = ['规则集', '系统', '地区', '入口', '服务', '订阅'] as const;

/** Glyph + label per mihomo proxy-group type — used in the rail and badges. */
export const TYPE_GLYPH: Record<ProxyGroupType, string> = {
  select: '◉',
  'url-test': '⚡',
  fallback: '↻',
  'load-balance': '⚖',
  relay: '⛓',
};

export const TYPE_LABELS: Record<ProxyGroupType, string> = {
  select: 'select',
  'url-test': 'url-test',
  fallback: 'fallback',
  'load-balance': 'load-balance',
  relay: 'relay',
};

/** Types that health-check and therefore accept url/interval/tolerance/… */
export const HEALTH_TYPES = new Set<ProxyGroupType>(['url-test', 'fallback', 'load-balance']);

/** mihomo built-in policies offered in the member picker. */
export const BUILTINS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'] as const;

/** Built-in region quick-fills: name suggestion + filter regex. */
export const REGIONS: { code: string; label: string; nameSuggestion: string; filter: string }[] = [
  { code: 'HK', label: '香港', nameSuggestion: '香港', filter: '香港|HK|Hong ?Kong|🇭🇰' },
  { code: 'JP', label: '日本', nameSuggestion: '日本', filter: '日本|JP|Japan|🇯🇵' },
  { code: 'TW', label: '台湾', nameSuggestion: '台湾', filter: '台湾|台灣|TW|Taiwan|🇹🇼' },
  { code: 'US', label: '美国', nameSuggestion: '美国', filter: '美国|美國|US|United ?States|🇺🇸' },
  { code: 'SG', label: '新加坡', nameSuggestion: '新加坡', filter: '新加坡|狮城|SG|Singapore|🇸🇬' },
  { code: 'DE', label: '德国', nameSuggestion: '德国', filter: '德国|德國|DE|Germany|🇩🇪' },
  { code: 'KR', label: '韩国', nameSuggestion: '韩国', filter: '韩国|韓國|KR|Korea|🇰🇷' },
  {
    code: 'UK',
    label: '英国',
    nameSuggestion: '英国',
    filter: '英国|英國|UK|GB|United ?Kingdom|🇬🇧',
  },
];

/**
 * How the editor sources a group's membership for a given kind:
 *   - 'composer'        → the visual member composer (手选 + 自动纳入)
 *   - 'bound-sub'       → pick one subscription; members computed at render
 *   - 'bound-collection'→ pick one collection; members computed at render
 *   - 'auto-pair'       → bespoke create flow that emits two groups
 */
export type MembershipMode = 'composer' | 'bound-sub';

export function membershipMode(kind: ProxyGroupKind): MembershipMode {
  return kind === 'single-sub' ? 'bound-sub' : 'composer';
}

/** Mirror of resolve.ts escapeRegex so the client preview matches the renderer. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── Form state ─────────────────────────────────────────────────────── */

export type FormState = {
  name: string;
  type: ProxyGroupType;
  kind: ProxyGroupKind;
  section: string;
  rank: string;
  notes: string;
  template_id: string;
  bound_subscription_id: string;
  bound_collection_id: string;
  // members
  proxies: string[];
  use: string; // newline-separated provider names
  'include-all-proxies': boolean;
  'include-all-providers': boolean;
  'include-all': boolean;
  filter: string;
  'exclude-filter': string;
  'exclude-type': string;
  // health-check
  url: string;
  interval: string;
  tolerance: string;
  lazy: boolean;
  'expected-status': string;
  'max-failed-times': string;
  timeout: string;
  // misc
  strategy: string;
  'dialer-proxy': string;
  'routing-mark': string;
  'disable-udp': boolean;
  hidden: boolean;
  icon: string;
};

export const EMPTY_FORM: FormState = {
  name: '',
  type: 'select',
  kind: 'raw',
  section: '',
  rank: '',
  notes: '',
  template_id: '',
  bound_subscription_id: '',
  bound_collection_id: '',
  proxies: [],
  use: '',
  'include-all-proxies': false,
  'include-all-providers': false,
  'include-all': false,
  filter: '',
  'exclude-filter': '',
  'exclude-type': '',
  url: '',
  interval: '',
  tolerance: '',
  lazy: false,
  'expected-status': '',
  'max-failed-times': '',
  timeout: '',
  strategy: '',
  'dialer-proxy': '',
  'routing-mark': '',
  'disable-udp': false,
  hidden: false,
  icon: '',
};

export function fromGroup(g: ProxyGroup): FormState {
  return {
    ...EMPTY_FORM,
    name: g.name,
    type: g.type,
    kind: g.kind,
    section: g.section ?? '',
    rank: String(g.rank),
    notes: g.notes ?? '',
    template_id: g.template_id ?? '',
    bound_subscription_id: g.bound_subscription_id ?? '',
    bound_collection_id: g.bound_collection_id ?? '',
    proxies: g.proxies ?? [],
    use: (g.use ?? []).join('\n'),
    'include-all-proxies': g['include-all-proxies'] ?? false,
    'include-all-providers': g['include-all-providers'] ?? false,
    'include-all': g['include-all'] ?? false,
    filter: g.filter ?? '',
    'exclude-filter': g['exclude-filter'] ?? '',
    'exclude-type': g['exclude-type'] ?? '',
    url: g.url ?? '',
    interval: g.interval !== undefined ? String(g.interval) : '',
    tolerance: g.tolerance !== undefined ? String(g.tolerance) : '',
    lazy: g.lazy ?? false,
    'expected-status': g['expected-status'] ?? '',
    'max-failed-times': g['max-failed-times'] !== undefined ? String(g['max-failed-times']) : '',
    timeout: g.timeout !== undefined ? String(g.timeout) : '',
    strategy: g.strategy ?? '',
    'dialer-proxy': g['dialer-proxy'] ?? '',
    'routing-mark': g['routing-mark'] !== undefined ? String(g['routing-mark']) : '',
    'disable-udp': g['disable-udp'] ?? false,
    hidden: g.hidden ?? false,
    icon: g.icon ?? '',
  };
}

/**
 * Serialise the form into the create/update payload. Empty strings → omitted,
 * numerics pass through Number() (NaN drops the field). Health-check fields
 * are only emitted for health-checking types; strategy only for load-balance.
 */
export function toPayload(s: FormState): Record<string, unknown> {
  const num = (raw: string): number | undefined => {
    const t = raw.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (raw: string): string | undefined => {
    const t = raw.trim();
    return t === '' ? undefined : t;
  };
  const lines = (raw: string) =>
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  const out: Record<string, unknown> = {
    name: s.name.trim(),
    type: s.type,
    kind: s.kind,
  };
  if (s.section.trim()) out.section = s.section.trim();
  const rank = num(s.rank);
  if (rank !== undefined && rank >= 0) out.rank = rank;
  if (s.notes.trim()) out.notes = s.notes.trim();
  if (s.template_id) out.template_id = s.template_id;
  if (s.bound_subscription_id) out.bound_subscription_id = s.bound_subscription_id;
  if (s.bound_collection_id) out.bound_collection_id = s.bound_collection_id;

  const proxies = s.proxies.map((p) => p.trim()).filter(Boolean);
  if (proxies.length > 0) out.proxies = proxies;
  const use = lines(s.use);
  if (use.length > 0) out.use = use;
  if (s['include-all-proxies']) out['include-all-proxies'] = true;
  if (s['include-all-providers']) out['include-all-providers'] = true;
  if (s['include-all']) out['include-all'] = true;
  if (str(s.filter)) out.filter = str(s.filter);
  if (str(s['exclude-filter'])) out['exclude-filter'] = str(s['exclude-filter']);
  if (str(s['exclude-type'])) out['exclude-type'] = str(s['exclude-type']);

  if (HEALTH_TYPES.has(s.type)) {
    if (str(s.url)) out.url = str(s.url);
    const iv = num(s.interval);
    if (iv !== undefined) out.interval = iv;
    const tol = num(s.tolerance);
    if (tol !== undefined) out.tolerance = tol;
    if (s.lazy) out.lazy = true;
    if (str(s['expected-status'])) out['expected-status'] = str(s['expected-status']);
    const mft = num(s['max-failed-times']);
    if (mft !== undefined) out['max-failed-times'] = mft;
    const to = num(s.timeout);
    if (to !== undefined) out.timeout = to;
  }
  if (s.type === 'load-balance' && str(s.strategy)) {
    out.strategy = str(s.strategy);
  }
  if (str(s['dialer-proxy'])) out['dialer-proxy'] = str(s['dialer-proxy']);
  const rm = num(s['routing-mark']);
  if (rm !== undefined) out['routing-mark'] = rm;
  if (s['disable-udp']) out['disable-udp'] = true;
  if (s.hidden) out.hidden = true;
  if (str(s.icon)) out.icon = str(s.icon);
  return out;
}

/* ─── YAML preview ───────────────────────────────────────────────────── */

/** mihomo proxy-group field render order (metadata fields excluded). */
export const MIHOMO_FIELD_ORDER = [
  'name',
  'type',
  'proxies',
  'use',
  'include-all-proxies',
  'include-all-providers',
  'include-all',
  'filter',
  'exclude-filter',
  'exclude-type',
  'url',
  'interval',
  'tolerance',
  'lazy',
  'expected-status',
  'max-failed-times',
  'timeout',
  'strategy',
  'dialer-proxy',
  'routing-mark',
  'disable-udp',
  'hidden',
  'icon',
] as const;

/** Quote a scalar when YAML would otherwise mis-parse it. */
function yamlScalar(s: string): string {
  if (s === '') return '""';
  if (/[:#[\]{}",&*!|>%@`]/.test(s) || /^[\s-]/.test(s) || /\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Minimal proxy-group YAML renderer for the live preview (mihomo fields only). */
export function yamlPreview(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  let first = true;
  const lead = () => (first ? '- ' : '  ');
  for (const key of MIHOMO_FIELD_ORDER) {
    const v = payload[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${lead()}${key}:${v.length === 0 ? ' []' : ''}`);
      first = false;
      for (const item of v) lines.push(`    - ${yamlScalar(String(item))}`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${lead()}${key}: ${String(v)}`);
      first = false;
    } else {
      lines.push(`${lead()}${key}: ${yamlScalar(String(v))}`);
      first = false;
    }
  }
  return lines.join('\n');
}

/** Preset-specific defaults applied when a kind is picked in the wizard. */
export function presetDefaults(kind: ProxyGroupKind): Partial<FormState> {
  switch (kind) {
    case 'filter':
      return {
        type: 'url-test',
        'include-all-proxies': true,
        url: 'http://www.gstatic.com/generate_204',
        interval: '600',
        tolerance: '50',
      };
    case 'all':
      return {
        type: 'select',
        'include-all-proxies': true,
      };
    case 'single-sub':
    case 'manual':
      return { type: 'select' };
    case 'raw':
    default:
      return {};
  }
}
