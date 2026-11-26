/**
 * Pure helpers for 节点来源 (subscription sources + pools). No React, no
 * runtime imports from `@/schemas` (that would drag zod into the bundle).
 */
import type { Collection, SubscriptionAdminView } from '@/ui/data/types';

export type Source = SubscriptionAdminView;
export type Pool = Collection;

export const SLUG_RE = /^[a-z0-9-]+$/;
export const DEFAULT_UA = 'clash.meta/1.18.0';
export const DEFAULT_TTL_MINUTES = 10;

export type FailurePolicy = 'use-stale-cache' | 'fail-closed';

export const POLICY_OPTIONS: Array<{ value: FailurePolicy; title: string; description: string }> = [
  {
    value: 'use-stale-cache',
    title: '沿用缓存（默认）',
    description: '拉取失败时使用上一次校验通过的缓存；如果还没有缓存，作为聚合订阅成员时会被暂时跳过。',
  },
  {
    value: 'fail-closed',
    title: '失败时阻断',
    description: '从不使用缓存，也不会被跳过：拉取失败会直接报错，用到它的配置文件这次更新也会失败。',
  },
];

/* ─── names & slugs ──────────────────────────────────────────────────── */

export function sourceTitle(source: Pick<Source, 'display_name' | 'name'>): string {
  return source.display_name?.trim() || source.name;
}

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const HOST_NOISE = new Set(['www', 'sub', 'subs', 'api', 'link', 'links', 'subscribe', 'dl', 'cdn', 'raw']);

/** Slug suggestion: latin parts of the display name, else the URL host's first meaningful label. */
export function suggestSourceSlug(displayName: string, url: string, taken: ReadonlySet<string>): string {
  let base = slugify(displayName);
  if (!base) {
    try {
      const labels = new URL(url.trim()).hostname.split('.').filter(Boolean);
      const meaningful = labels.slice(0, -1).find((label) => !HOST_NOISE.has(label)) ?? labels[0] ?? '';
      base = /^\d+$/.test(meaningful) ? '' : slugify(meaningful);
    } catch {
      base = '';
    }
  }
  return base ? uniqueSlug(base, taken) : '';
}

export function suggestPoolSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  return base ? uniqueSlug(base, taken) : '';
}

export function validateSlug(value: string, taken: ReadonlySet<string>, current?: string): string | null {
  if (!value) return '请填写标识';
  if (!SLUG_RE.test(value)) return '只能用小写字母、数字和短横线（-）';
  if (value !== current && taken.has(value)) return '已有同名标识，换一个吧';
  return null;
}

export function validateUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '请填写订阅链接';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '这不是一个有效的网址';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只支持 http:// 或 https:// 链接';
  if (url.username || url.password) return '链接里不能包含用户名或密码';
  return null;
}

export function validateTag(value: string): string | null {
  if (value.length > 40) return '标签太长了';
  if (/[,，\s]/.test(value)) return '标签里不能有空格或逗号';
  return null;
}

/* ─── request headers ────────────────────────────────────────────────── */

export interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Insecure contexts (plain http on a LAN) have no randomUUID; getRandomValues still works.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function headersToRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ id: newId(), name, value }));
}

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Per-row errors (keyed by row id) and the record to send. Blank rows are ignored. */
export function rowsToHeaders(rows: HeaderRow[]): { headers: Record<string, string>; errors: Record<string, string> } {
  const headers: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!name) {
      errors[row.id] = '请填写请求头名称';
      continue;
    }
    if (!HEADER_NAME_RE.test(name)) {
      errors[row.id] = '名称只能包含字母、数字和 - 等符号';
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'user-agent') {
      errors[row.id] = 'User-Agent 请在上面单独设置';
      continue;
    }
    if (seen.has(lower)) {
      errors[row.id] = '重复的请求头';
      continue;
    }
    seen.add(lower);
    headers[name] = value;
  }
  return { headers, errors };
}

export function sameHeaders(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const ea = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y));
  const eb = Object.entries(b ?? {}).sort(([x], [y]) => x.localeCompare(y));
  return ea.length === eb.length && ea.every(([k, v], i) => eb[i][0] === k && eb[i][1] === v);
}

/* ─── TTL ────────────────────────────────────────────────────────────── */

export const msToMinutes = (ms: number | undefined) => Math.max(1, Math.round((ms ?? DEFAULT_TTL_MINUTES * 60_000) / 60_000));

export function validateTtl(value: string): string | null {
  if (!value.trim()) return '请填写缓存时长';
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return '请填写大于 0 的整数分钟数';
  if (n > 7 * 24 * 60) return '最长 7 天（10080 分钟）';
  return null;
}

/* ─── source facts ───────────────────────────────────────────────────── */

export type SourceMode = 'local' | 'manual' | 'server-manual' | 'auto';

export function sourceMode(source: Pick<Source, 'kind' | 'refresh_mode'>): SourceMode {
  if (source.kind === 'local') return 'local';
  if (source.refresh_mode === 'manual') return 'manual';
  if (source.refresh_mode === 'server-manual') return 'server-manual';
  return 'auto';
}

export const MODE_LABEL: Record<SourceMode, string> = {
  local: '本地',
  manual: '手动导入',
  'server-manual': '仅手动刷新',
  auto: '远程',
};

/** The node count we can honestly state from the list view (null = unknown). */
export function knownNodeCount(source: Source): number | null {
  if (!source.enabled) return null;
  if (source.kind === 'local') return null;
  if (source.refresh_mode === 'manual' || source.refresh_mode === 'server-manual') {
    return source.manual_snapshot?.proxy_count ?? null;
  }
  const health = source.fetch_health;
  if (!health || health.state === 'failed-no-cache') return null;
  return health.proxy_count;
}

export function canServerRefresh(source: Source): boolean {
  const mode = sourceMode(source);
  return source.enabled && (mode === 'auto' || mode === 'server-manual');
}

export function canAutoRefresh(source: Source): boolean {
  return source.enabled && sourceMode(source) === 'auto';
}

/* ─── pools ──────────────────────────────────────────────────────────── */

export interface PoolMember {
  id: string;
  source: Source | null;
  via: 'explicit' | 'tag';
  matchedTags: string[];
}

/** Same order as the server: explicit ids first (deduped), then tag matches in list order. */
export function resolvePoolMembers(
  pool: Pick<Pool, 'subscription_ids' | 'subscription_tags'>,
  sources: Source[],
): PoolMember[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const out: PoolMember[] = [];
  const seen = new Set<string>();
  for (const id of pool.subscription_ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const source = byId.get(id) ?? null;
    out.push({
      id,
      source,
      via: 'explicit',
      matchedTags: source ? source.tags.filter((t) => pool.subscription_tags.includes(t)) : [],
    });
  }
  if (pool.subscription_tags.length > 0) {
    for (const source of sources) {
      if (seen.has(source.id)) continue;
      const matched = source.tags.filter((t) => pool.subscription_tags.includes(t));
      if (matched.length === 0) continue;
      seen.add(source.id);
      out.push({ id: source.id, source, via: 'tag', matchedTags: matched });
    }
  }
  return out;
}

export function activeMembers(members: PoolMember[]): Source[] {
  return members.flatMap((m) => (m.source && m.source.enabled ? [m.source] : []));
}

export function poolLinkKey(pool: Pick<Pool, 'slug' | 'id'>): string {
  return pool.slug || pool.id;
}

/* ─── distribution ───────────────────────────────────────────────────── */

export function sourceLink(subBase: string, source: Pick<Source, 'name'>): string {
  return `${subBase}/source/${encodeURIComponent(source.name)}`;
}

export function poolLink(subBase: string, pool: Pick<Pool, 'slug' | 'id'>): string {
  return `${subBase}/collection/${encodeURIComponent(poolLinkKey(pool))}`;
}

export function withBase64(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}format=base64`;
}

/* ─── misc ───────────────────────────────────────────────────────────── */

/** Key-order-insensitive, undefined-dropping serialisation for dirty checks. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          if (record[k] !== undefined) acc[k] = record[k];
          return acc;
        }, {});
    }
    return v;
  });
}

export function sortSources(sources: Source[]): Source[] {
  return sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(b.s.enabled) - Number(a.s.enabled) || a.i - b.i)
    .map(({ s }) => s);
}
