import { compileGoRegex, matchFilter } from '@/lib/proxies/filterMatch';
import type {
  Collection,
  Profile,
  ProxyGroup,
  ProxyGroupTemplate,
  ProxyGroupType,
  SubscriptionAdminView,
} from '@/ui/data/types';
import { BUILTIN_LABEL, BUILTIN_POLICIES, isBuiltinPolicy } from '@/ui/viz/lines';

/* ─── constants ──────────────────────────────────────────────────────── */

export const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';
export const GROUP_TYPE_ORDER: ProxyGroupType[] = ['select', 'url-test', 'fallback', 'load-balance'];
export const HEALTH_TYPES: ProxyGroupType[] = ['url-test', 'fallback', 'load-balance'];
export const isHealthType = (type: string) => (HEALTH_TYPES as string[]).includes(type);

export const LB_STRATEGIES = [
  { value: 'consistent-hashing', label: '一致性哈希', description: '同一个目标网站总是走同一个成员' },
  { value: 'round-robin', label: '轮询', description: '新连接依次分给每个成员' },
  { value: 'sticky-sessions', label: '粘性会话', description: '同一来源访问同一目标时，一段时间内保持同一成员' },
] as const;

/** Mihomo AdapterType names accepted by `exclude-type`, with the YAML `type:` they cover. */
export const ADAPTER_TYPES: Array<{ value: string; yaml: string }> = [
  { value: 'Shadowsocks', yaml: 'ss' },
  { value: 'ShadowsocksR', yaml: 'ssr' },
  { value: 'Vmess', yaml: 'vmess' },
  { value: 'Vless', yaml: 'vless' },
  { value: 'Trojan', yaml: 'trojan' },
  { value: 'Hysteria', yaml: 'hysteria' },
  { value: 'Hysteria2', yaml: 'hysteria2' },
  { value: 'Tuic', yaml: 'tuic' },
  { value: 'WireGuard', yaml: 'wireguard' },
  { value: 'AnyTLS', yaml: 'anytls' },
  { value: 'Snell', yaml: 'snell' },
  { value: 'Socks5', yaml: 'socks5' },
  { value: 'Http', yaml: 'http' },
  { value: 'Ssh', yaml: 'ssh' },
  { value: 'Mieru', yaml: 'mieru' },
  { value: 'Direct', yaml: 'direct' },
];

const YAML_TO_ADAPTER = new Map(ADAPTER_TYPES.map((t) => [t.yaml, t.value.toLowerCase()]));

/** Quick-fill patterns for region groups. Two-letter codes are guarded so `US` never matches `RUSSIA`. */
export const REGION_PRESETS = [
  { code: 'HK', label: '香港', name: '香港节点', pattern: '(?i)港|HK|Hong ?Kong' },
  { code: 'TW', label: '台湾', name: '台湾节点', pattern: '(?i)台湾|台北|TW|Taiwan' },
  { code: 'JP', label: '日本', name: '日本节点', pattern: '(?i)日本|东京|大阪|JP|Japan|Tokyo|Osaka' },
  { code: 'SG', label: '新加坡', name: '新加坡节点', pattern: '(?i)新加坡|狮城|SG|Singapore' },
  { code: 'US', label: '美国', name: '美国节点', pattern: '(?i)美国|洛杉矶|纽约|圣何塞|(?<![A-Za-z])US(?![A-Za-z])|United States' },
  { code: 'KR', label: '韩国', name: '韩国节点', pattern: '(?i)韩国|首尔|KR|Korea|Seoul' },
  { code: 'GB', label: '英国', name: '英国节点', pattern: '(?i)英国|伦敦|(?<![A-Za-z])UK(?![A-Za-z])|United Kingdom|London' },
  { code: 'DE', label: '德国', name: '德国节点', pattern: '(?i)德国|法兰克福|(?<![A-Za-z])DE(?![A-Za-z])|Germany|Frankfurt' },
] as const;

/* ─── membership modes ───────────────────────────────────────────────── */

/** How members are sourced. Maps 1:1 to `kind` (manual / filter|all / single-sub / raw). */
export type MemberMode = 'manual' | 'auto' | 'bound' | 'raw';

export function modeOf(group: Pick<ProxyGroup, 'kind' | 'include-all-proxies'>): MemberMode {
  if (group.kind === 'single-sub') return 'bound';
  if (group.kind === 'raw') return 'raw';
  return group['include-all-proxies'] ? 'auto' : 'manual';
}

/* ─── draft (form state) ─────────────────────────────────────────────── */

export interface Draft {
  name: string;
  type: ProxyGroupType;
  hidden: boolean;
  mode: MemberMode;
  proxies: string[];
  /** include-all-proxies (only edited directly for raw groups; auto mode forces it on). */
  includeAll: boolean;
  filter: string;
  excludeFilter: string;
  excludeType: string[];
  boundSubscriptionId: string;
  url: string;
  interval: string;
  tolerance: string;
  timeout: string;
  lazy: boolean | undefined;
  expectedStatus: string;
  maxFailedTimes: string;
  strategy: string;
  templateId: string;
  emptyFallback: string;
  dialerProxy: string;
  disableUdp: boolean | undefined;
  icon: string;
  routingMark: string;
  section: string;
  notes: string;
}

const str = (value: number | undefined) => (value === undefined ? '' : String(value));

export function toDraft(g: ProxyGroup): Draft {
  return {
    name: g.name,
    type: g.type,
    hidden: !!g.hidden,
    mode: modeOf(g),
    proxies: g.proxies ?? [],
    includeAll: !!g['include-all-proxies'],
    filter: g.filter ?? '',
    excludeFilter: g['exclude-filter'] ?? '',
    excludeType: g['exclude-type'] ? g['exclude-type'].split('|').filter(Boolean) : [],
    boundSubscriptionId: g.bound_subscription_id ?? '',
    url: g.url ?? '',
    interval: str(g.interval),
    tolerance: str(g.tolerance),
    timeout: str(g.timeout),
    lazy: g.lazy,
    expectedStatus: g['expected-status'] ?? '',
    maxFailedTimes: str(g['max-failed-times']),
    strategy: g.strategy ?? '',
    templateId: g.template_id ?? '',
    emptyFallback: g['empty-fallback'] ?? '',
    dialerProxy: g['dialer-proxy'] ?? '',
    disableUdp: g['disable-udp'],
    icon: g.icon ?? '',
    routingMark: str(g['routing-mark']),
    section: g.section ?? '',
    notes: g.notes ?? '',
  };
}

export const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

const int = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : undefined;
};
const text = (value: string) => value.trim() || undefined;

type ApiRecord = Record<string, unknown>;

/** The API-level member fields a draft stands for. */
function membershipFields(d: Draft, original: ProxyGroup | null): ApiRecord {
  const excludeType = d.excludeType.length ? d.excludeType.join('|') : undefined;
  switch (d.mode) {
    case 'manual':
      return {
        kind: 'manual',
        proxies: d.proxies,
        'include-all-proxies': false,
        filter: undefined,
        'exclude-filter': undefined,
        'exclude-type': undefined,
        bound_subscription_id: undefined,
      };
    case 'auto':
      return {
        kind: d.filter.trim() ? 'filter' : 'all',
        proxies: d.proxies,
        'include-all-proxies': true,
        filter: text(d.filter),
        'exclude-filter': text(d.excludeFilter),
        'exclude-type': excludeType,
        bound_subscription_id: undefined,
      };
    case 'bound':
      return {
        kind: 'single-sub',
        proxies: [],
        'include-all-proxies': false,
        filter: undefined,
        'exclude-filter': undefined,
        'exclude-type': undefined,
        bound_subscription_id: d.boundSubscriptionId || undefined,
      };
    default:
      return {
        kind: 'raw',
        proxies: d.proxies,
        'include-all-proxies': d.includeAll,
        filter: text(d.filter),
        'exclude-filter': text(d.excludeFilter),
        'exclude-type': excludeType,
        bound_subscription_id: original?.bound_subscription_id,
      };
  }
}

/** Full API representation of a draft (`undefined` = field absent). */
export function draftToApi(d: Draft, original: ProxyGroup | null): ApiRecord {
  return {
    name: d.name.trim(),
    type: d.type,
    hidden: d.hidden,
    ...membershipFields(d, original),
    url: text(d.url),
    interval: int(d.interval),
    tolerance: int(d.tolerance),
    timeout: int(d.timeout),
    lazy: d.lazy,
    'expected-status': text(d.expectedStatus),
    'max-failed-times': int(d.maxFailedTimes),
    strategy: d.strategy || undefined,
    template_id: d.templateId || undefined,
    'empty-fallback': d.emptyFallback || undefined,
    'dialer-proxy': d.dialerProxy || undefined,
    'disable-udp': d.disableUdp,
    icon: text(d.icon),
    'routing-mark': int(d.routingMark),
    section: text(d.section),
    notes: text(d.notes),
  };
}

function currentApi(g: ProxyGroup): ApiRecord {
  const record = g as unknown as ApiRecord;
  return {
    ...record,
    hidden: !!g.hidden,
    proxies: g.proxies ?? [],
    'include-all-proxies': !!g['include-all-proxies'],
  };
}

/** Fields the PATCH endpoint can clear with `null`. Anything else cannot be removed once set. */
const NULLABLE = new Set([
  'filter',
  'exclude-filter',
  'exclude-type',
  'empty-fallback',
  'dialer-proxy',
  'section',
  'notes',
  'template_id',
  'bound_subscription_id',
]);

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a ?? []) === JSON.stringify(b ?? []) : a === b;

/** Minimal PATCH body: only changed fields; cleared strings become `null`. */
export function buildPatch(group: ProxyGroup, d: Draft): ApiRecord {
  const target = draftToApi(d, group);
  const current = currentApi(group);
  const patch: ApiRecord = {};
  for (const [key, value] of Object.entries(target)) {
    if (same(current[key], value)) continue;
    if (value === undefined) {
      if (NULLABLE.has(key)) patch[key] = null;
      continue;
    }
    patch[key] = value;
  }
  return patch;
}

/** POST body for a brand-new group (copy / presets). */
export function createBody(d: Draft): ApiRecord {
  const body = draftToApi(d, null);
  const out: ApiRecord = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === 'hidden' && value === false) continue;
    if (key === 'include-all-proxies' && value === false) continue;
    if (key === 'proxies' && Array.isArray(value) && value.length === 0 && d.mode !== 'manual') continue;
    out[key] = value;
  }
  return out;
}

/* ─── validation ─────────────────────────────────────────────────────── */

export type DraftErrors = Partial<Record<keyof Draft | 'members', string>>;

const NOT_CLEARABLE = '保存后无法清空这一项，请填一个值';

export function validateDraft(
  d: Draft,
  ctx: { original: ProxyGroup | null; otherNames: Set<string>; regexError: string | null; excludeError: string | null },
): DraftErrors {
  const errors: DraftErrors = {};
  const name = d.name.trim();
  if (!name) errors.name = '名字不能为空';
  else if (ctx.otherNames.has(name)) errors.name = '已经有同名的策略组';
  else if (isBuiltinPolicy(name)) errors.name = `${name} 是内置策略，不能用作名字`;

  if (d.mode === 'manual' && d.proxies.length === 0) errors.members = '至少添加一个成员';
  if (d.mode === 'bound' && !d.boundSubscriptionId) errors.members = '请选择要绑定的订阅源';
  if ((d.mode === 'auto' || d.mode === 'raw') && ctx.regexError) errors.filter = ctx.regexError;
  if ((d.mode === 'auto' || d.mode === 'raw') && ctx.excludeError) errors.excludeFilter = ctx.excludeError;

  const numeric: Array<[keyof Draft, number]> = [
    ['interval', 1],
    ['tolerance', 0],
    ['timeout', 1],
    ['maxFailedTimes', 1],
  ];
  for (const [key, min] of numeric) {
    const raw = (d[key] as string).trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) errors[key] = min === 0 ? '请输入不小于 0 的整数' : '请输入正整数';
  }
  if (d.routingMark.trim() && !Number.isInteger(Number(d.routingMark.trim()))) errors.routingMark = '请输入整数';
  if (d.url.trim() && !/^https?:\/\//i.test(d.url.trim())) errors.url = '测速地址需要以 http:// 或 https:// 开头';

  const o = ctx.original;
  if (o) {
    const cleared: Array<[keyof Draft, unknown]> = [
      ['url', o.url],
      ['interval', o.interval],
      ['tolerance', o.tolerance],
      ['timeout', o.timeout],
      ['expectedStatus', o['expected-status']],
      ['maxFailedTimes', o['max-failed-times']],
      ['icon', o.icon],
      ['routingMark', o['routing-mark']],
    ];
    for (const [key, before] of cleared) {
      if (before !== undefined && before !== '' && !(d[key] as string).trim() && !errors[key]) errors[key] = NOT_CLEARABLE;
    }
  }
  return errors;
}

/* ─── members ────────────────────────────────────────────────────────── */

export type MemberKind = 'group' | 'node' | 'builtin' | 'missing';

export function memberKind(name: string, groupNames: Set<string>, nodeNames: Set<string> | null): MemberKind {
  if (isBuiltinPolicy(name)) return 'builtin';
  if (groupNames.has(name)) return 'group';
  if (!nodeNames || nodeNames.has(name)) return 'node';
  return 'missing';
}

export const BUILTIN_OPTIONS = BUILTIN_POLICIES.map((name) => ({ name, label: BUILTIN_LABEL[name] }));

/** Groups that (directly or through other groups) include `name` — adding them as members would loop. */
export function ancestorsOf(name: string, groups: ProxyGroup[]): Set<string> {
  const parents = new Map<string, string[]>();
  for (const g of groups) {
    for (const member of g.proxies ?? []) {
      const list = parents.get(member) ?? [];
      list.push(g.name);
      parents.set(member, list);
    }
  }
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length) {
    const current = queue.shift()!;
    for (const parent of parents.get(current) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return seen;
}

/** Chain front pools (groups another group dials through). Mirrors `frontPoolGroupNames` in the schema. */
export function frontPoolNames(groups: Array<{ name: string; 'dialer-proxy'?: string | null }>): Set<string> {
  const names = new Set(groups.map((g) => g.name));
  const pools = new Set<string>();
  for (const g of groups) {
    const dp = g['dialer-proxy'];
    if (dp && names.has(dp)) pools.add(dp);
  }
  return pools;
}

/** Nodes an include-all group keeps: regex filter, exclude-filter, then exclude-type. */
export function autoMembers(
  nodeNames: string[],
  filter: string,
  excludeFilter: string,
  excludeType: string[],
  nodeTypes: Map<string, string> | null,
): { matched: string[]; error: string | null; excludeError: string | null; typeDropped: number } {
  const include = matchFilter(nodeNames, filter);
  if (include.error) {
    const exclusionOnly = matchFilter(nodeNames, '', excludeFilter);
    return { matched: [], error: include.error, excludeError: exclusionOnly.error, typeDropped: 0 };
  }
  const excluded = matchFilter(include.matched, '', excludeFilter);
  if (excluded.error) return { matched: include.matched, error: null, excludeError: excluded.error, typeDropped: 0 };
  let matched = excluded.matched;
  let typeDropped = 0;
  if (excludeType.length && nodeTypes) {
    const banned = new Set(excludeType.map((t) => t.toLowerCase()));
    matched = matched.filter((name) => {
      const yaml = nodeTypes.get(name);
      const adapter = yaml ? (YAML_TO_ADAPTER.get(yaml.toLowerCase()) ?? yaml.toLowerCase()) : null;
      const drop = adapter !== null && banned.has(adapter);
      if (drop) typeDropped++;
      return !drop;
    });
  }
  return { matched, error: null, excludeError: null, typeDropped };
}

export function adapterOfYaml(yaml: string): string | undefined {
  return ADAPTER_TYPES.find((t) => t.yaml === yaml.toLowerCase())?.value;
}

/** Character ranges of `label` matched by any backtick-separated pattern (best effort, for highlighting). */
export function highlightRanges(label: string, filter: string): Array<[number, number]> {
  if (!filter.trim()) return [];
  const ranges: Array<[number, number]> = [];
  for (const pattern of filter.split('`')) {
    try {
      const re = compileGoRegex(pattern);
      const m = re.exec(label);
      if (m && m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
    } catch {
      /* invalid pattern: no highlight */
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** `(?i)港|HK|Hong` → `港|HK|Hong` for compact display. */
export function prettyPattern(pattern: string): string {
  return pattern.replace(/^\(\?[a-z]+\)/i, '').trim();
}

/* ─── list helpers ───────────────────────────────────────────────────── */

export interface Bucket {
  section: string;
  groups: ProxyGroup[];
}

/** Sections in order of first appearance (by rank); ungrouped last. */
export function bucketBySection(groups: ProxyGroup[]): Bucket[] {
  const sorted = groups.slice().sort((a, b) => a.rank - b.rank);
  const map = new Map<string, ProxyGroup[]>();
  for (const g of sorted) {
    const key = g.section?.trim() ?? '';
    const list = map.get(key) ?? [];
    list.push(g);
    map.set(key, list);
  }
  const named = [...map.entries()].filter(([k]) => k);
  const rest = map.get('');
  return [...named.map(([section, list]) => ({ section, groups: list })), ...(rest ? [{ section: '', groups: rest }] : [])];
}

export interface CatalogLike {
  names: string[] | null;
  bySub: Record<string, string[]> | null;
  types: Map<string, string> | null;
}

export interface SummaryContext {
  catalog: CatalogLike;
  groupNames: Set<string>;
  subsById: Map<string, SubscriptionAdminView>;
}

export function sourceLabel(sub: Pick<SubscriptionAdminView, 'display_name' | 'name'> | undefined): string {
  return sub ? sub.display_name || sub.name : '未知订阅源';
}

/** Node names an include-all / bound group resolves to (null = unknown). */
export function resolvedNodes(g: ProxyGroup, ctx: SummaryContext): string[] | null {
  const { catalog } = ctx;
  if (g.kind === 'single-sub') {
    const sub = g.bound_subscription_id ? ctx.subsById.get(g.bound_subscription_id) : undefined;
    if (!sub || !catalog.bySub) return null;
    return catalog.bySub[sub.name] ?? [];
  }
  if (g['include-all-proxies'] && catalog.names) {
    const types = g['exclude-type'] ? g['exclude-type'].split('|') : [];
    return autoMembers(catalog.names, g.filter ?? '', g['exclude-filter'] ?? '', types, catalog.types).matched;
  }
  return null;
}

/** One-line member description for list rows. */
export function memberSummary(g: ProxyGroup, ctx: SummaryContext): string {
  if (g.kind === 'single-sub') {
    return `绑定 · ${sourceLabel(g.bound_subscription_id ? ctx.subsById.get(g.bound_subscription_id) : undefined)}`;
  }
  if (g.kind === 'raw') return '原始写法';
  if (g['include-all-proxies']) {
    if (g.filter) return `正则 ${prettyPattern(g.filter)}`;
    const nodes = resolvedNodes(g, ctx);
    return nodes ? `${nodes.length} 个节点` : '全部节点';
  }
  const members = g.proxies ?? [];
  const nodeCount = members.filter((m) => !ctx.groupNames.has(m) && !isBuiltinPolicy(m)).length;
  if (members.length > 0 && nodeCount === members.length) return `${members.length} 个节点`;
  return `${members.length} 个成员`;
}

/* ─── profile sources ────────────────────────────────────────────────── */

/** Subscription ids that feed a profile's nodes (null while loading). */
export function profileSourceIds(
  profile: Profile,
  sources: SubscriptionAdminView[] | undefined,
  pools: Collection[] | undefined,
): Set<string> | null {
  const source = profile.source;
  if (!source || source.type === 'none') return new Set();
  if (source.type === 'subscription') return new Set(source.id ? [source.id] : []);
  if (!sources || !pools) return null;
  const pool = pools.find((p) => p.id === source.id);
  if (!pool) return new Set();
  const ids = new Set(pool.subscription_ids);
  for (const sub of sources) {
    if (sub.tags.some((t) => pool.subscription_tags.includes(t))) ids.add(sub.id);
  }
  return ids;
}

/* ─── naming ─────────────────────────────────────────────────────────── */

export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/* ─── templates ──────────────────────────────────────────────────────── */

export const TEMPLATE_FIELD_LABELS: Record<string, string> = {
  type: '类型',
  url: '测速地址',
  interval: '间隔',
  tolerance: '容差',
  lazy: '懒测速',
  'expected-status': '期望状态码',
  'max-failed-times': '失败次数',
  timeout: '超时',
  'disable-udp': '禁用 UDP',
  hidden: '隐藏',
  'include-all-providers': '全部代理集',
  'include-all-proxies': '全部节点',
  'include-all': '全部',
  'exclude-filter': '排除',
  'exclude-type': '排除类型',
  'empty-fallback': '空成员兜底',
  strategy: '策略',
  'dialer-proxy': '前置代理',
  'routing-mark': 'routing-mark',
  icon: '图标',
};

export function templateFieldText(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (key === 'interval') return `${value} 秒`;
  if (key === 'tolerance' || key === 'timeout') return `${value} 毫秒`;
  if (key === 'url' && typeof value === 'string') {
    try {
      return new URL(value).host;
    } catch {
      return value;
    }
  }
  return String(value);
}

/** Template fields that would apply to a group (the group leaves them unset). */
export function inheritedFields(template: ProxyGroupTemplate | undefined, d: Draft): Array<[string, unknown]> {
  if (!template) return [];
  const api = draftToApi(d, null);
  return Object.keys(TEMPLATE_FIELD_LABELS)
    .filter((key) => key !== 'type')
    .flatMap((key): Array<[string, unknown]> => {
      const value = (template as unknown as ApiRecord)[key];
      if (value === undefined) return [];
      const own = api[key];
      if (own !== undefined && own !== false) return [];
      return [[key, value]];
    });
}
