import type {
  ProxyGroup,
  ProxyGroupKind,
  ProxyGroupType,
} from '@/schemas';

/**
 * Shared client model for the 策略组 workspace.
 *
 * A proxy-group's membership comes from up to three composable sources:
 *   1. 手选  — explicit `proxies:` (builtins / other groups / individual nodes), ordered
 *   2. 自动纳入 — `include-all*` + `filter`/`exclude-filter`, with a live match preview
 *   3. 绑定  — render-time, kind-driven (single-sub → filter from node_prefix;
 *              collection-scope → proxies from member nodes). Read-only preview.
 *
 * `kind` is a *soft lens*, not a locked mode: it decides which source the
 * editor foregrounds and any render-time binding — but every native field
 * stays reachable in the advanced drawer, so there's no one-way "转 raw" trap.
 */

/* ─── Lightweight cross-resource shapes the page hands down ───────────── */

export interface SubscriptionLite {
  id: string;
  name: string;
  enabled: boolean;
  node_prefix?: string;
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

export const KIND_LABELS: Record<ProxyGroupKind, string> = {
  raw: '手选 / 自由',
  region: '地区组',
  'single-sub': '单订阅组',
  'collection-scope': '聚合订阅组',
  'rule-set-policy': '规则集策略组',
  service: '混合服务组',
  'all-auto-pair': '全部 + 自动对',
  system: '系统组',
};

export const KIND_DESCRIPTIONS: Record<ProxyGroupKind, string> = {
  raw: '点选内置 / 节点 / 其他策略组,自由组合成员',
  region: '按地区把节点自动归类(HK / JP / US …),靠 filter 正则纳入',
  'single-sub': '只用某一个订阅源的节点,渲染时 filter 从 node_prefix 自动生成',
  'collection-scope': '绑定一个聚合订阅,proxies 渲染时自动取其成员节点',
  'rule-set-policy': '某个规则集走指定的策略组,常共用一份 url-test 模板',
  service: '混合策略:显式列几个出口 + filter 兜底过滤(Emby 形态)',
  'all-auto-pair': '一键建两个组:全部节点(select)+ 自动选择(url-test)',
  system: '默认 / DNS / 国内 / 兜底 / 其他 等系统组',
};

/** Order shown in the intent picker (presets first, raw last as the escape hatch). */
export const KIND_ORDER: ProxyGroupKind[] = [
  'region',
  'single-sub',
  'collection-scope',
  'service',
  'all-auto-pair',
  'rule-set-policy',
  'system',
  'raw',
];

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
  { code: 'UK', label: '英国', nameSuggestion: '英国', filter: '英国|英國|UK|GB|United ?Kingdom|🇬🇧' },
];

/**
 * How the editor sources a group's membership for a given kind:
 *   - 'composer'        → the visual member composer (手选 + 自动纳入)
 *   - 'bound-sub'       → pick one subscription; members computed at render
 *   - 'bound-collection'→ pick one collection; members computed at render
 *   - 'auto-pair'       → bespoke create flow that emits two groups
 */
export type MembershipMode = 'composer' | 'bound-sub' | 'bound-collection' | 'auto-pair';

export function membershipMode(kind: ProxyGroupKind): MembershipMode {
  switch (kind) {
    case 'single-sub':
      return 'bound-sub';
    case 'collection-scope':
      return 'bound-collection';
    case 'all-auto-pair':
      return 'auto-pair';
    default:
      return 'composer';
  }
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
  // create-only helper: the auto-pair url-test group name
  autoPairName: string;
};

export const EMPTY_FORM: FormState = {
  name: '',
  type: 'select',
  kind: 'raw',
  section: '',
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
  autoPairName: '',
};

export function fromGroup(g: ProxyGroup): FormState {
  return {
    ...EMPTY_FORM,
    name: g.name,
    type: g.type,
    kind: g.kind,
    section: g.section ?? '',
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
    case 'region':
      return {
        type: 'url-test',
        'include-all-proxies': true,
        url: 'http://www.gstatic.com/generate_204',
        interval: '600',
        tolerance: '50',
      };
    case 'service':
      return { type: 'select', 'include-all-proxies': true };
    case 'all-auto-pair':
      return { type: 'select', url: 'http://www.gstatic.com/generate_204', interval: '600' };
    case 'single-sub':
    case 'collection-scope':
    case 'rule-set-policy':
    case 'system':
      return { type: 'select' };
    case 'raw':
    default:
      return {};
  }
}
