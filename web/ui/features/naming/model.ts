/**
 * Pure helpers for 智能命名 (the naming workspace). Client-safe: the template
 * grammar and renderer come from the shared compiler in lib/proxies/naming
 * (no node APIs), so validation here is exactly the server's.
 */
import {
  renderTemplate,
  validateTemplate,
  LINE_TAGS,
  type NamingField,
  type NodeFacts,
} from '@/lib/proxies/naming';
import type { SourceHealthReport } from '@/lib/proxies/namingHealth';
import type { NamingCandidate } from '@/lib/proxies/namingCandidates';
import { flagFromCode, regionByCode } from '@/lib/proxies/regions';
import type { NamesPayload, PreviewIssue } from '@/ui/data/types';

export type TargetType = 'subscription' | 'collection';
export type RuleField = 'route' | 'vendor' | 'region' | 'entry' | 'tag';

export function candidateRationale(candidate: NamingCandidate): string {
  const changed = candidate.groups.filter((g) => g.broken || g.error || g.before !== (g.migration?.after ?? g.after)).length;
  const migrated = candidate.groups.filter((g) => g.migration).length;
  const blocked = candidate.references.filter((ref) => ref.blocked).length;
  const reason = !candidate.groups.length ? '没有策略组，无需迁移筛选'
    : changed ? `${changed} 个策略组的成员或匹配数会变化，需核对`
      : migrated ? `${migrated} 个筛选将迁移，所有策略组匹配数不变`
        : '无需改写任何筛选，所有策略组匹配数不变';
  return reason + (blocked ? `；${blocked} 处精确引用无法自动迁移`
    : candidate.references.length ? `；${candidate.references.length} 处精确引用将同步改写` : '');
}

export interface RecognitionRule {
  pattern: string;
  field: RuleField;
  value: string;
}

export interface NamingPlan {
  nodeFacts?: NodeFacts;
  template: string;
  tw2cn: boolean;
  /** Keys are the opaque `src-…` handles round-tripped from GET. */
  sourceAliases: Record<string, string>;
  recognitionRules: RecognitionRule[];
}

export interface PlanView {
  nodeFacts?: NodeFacts;
  present: boolean;
  template?: string;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: RecognitionRule[];
  disabled?: boolean;
}

export interface OrphanIssue {
  code: 'orphaned-reference';
  kind: string;
  node: string;
  via: string;
}

export interface NamingWorkspaceData {
  configVersion: number;
  entity: { type: TargetType; ref: string; label: string };
  aggregate: boolean;
  managed: PlanView;
  priorPlan: PlanView;
  recommended: string;
  health: SourceHealthReport[];
  diagnostics: {
    memberWarnings?: Array<{ memberId: string; message: string }>;
    nodeCount: number;
    changed: number;
    collisions: string[];
    deduped: Array<{ kept: string; dropped: string; sourceKey?: string }>;
    beforeNames: string[];
    afterNames: string[];
    truncated: boolean;
  };
  references: {
    consumingProfiles: Array<{ id: string; name: string }>;
    orphaned: OrphanIssue[];
  };
}

export interface NamingPreviewData {
  after: NamesPayload;
  issues: PreviewIssue[];
  candidate: { id: string; index: number; mode: 'added' | 'replaced' | 'kept' };
}

export type Activation = 'absent' | 'disabled' | 'enabled';

/* ─── fields ─────────────────────────────────────────────────────────── */

export const FIELD_META: Record<NamingField, { label: string; hint: string; example: string }> = {
  emoji: { label: '国旗', hint: '按识别出的地区加上国旗', example: '🇭🇰' },
  region: { label: '地区', hint: '中文地区名', example: '香港' },
  region_code: { label: '地区代码', hint: '两位字母的地区代码', example: 'HK' },
  index: { label: '序号', hint: '同一来源内稳定的编号，订阅更新也不乱', example: '01' },
  route: { label: '线路', hint: '中转、直连、落地等线路类型', example: '中转' },
  rate: { label: '倍率', hint: '流量倍率，1x 默认不显示', example: '2x' },
  source: { label: '来源', hint: '节点来自哪个订阅源（可设别名）', example: 'Nebula' },
  protocol: { label: '协议', hint: '节点的协议类型', example: 'vless' },
  vendor: { label: '服务商', hint: '常见机场品牌，认不出就留空', example: 'TAG' },
  entry: { label: '入口', hint: '节点名写了「入口」时才有', example: '入口' },
  note: { label: '剩余文字', hint: '原名去掉已识别部分后剩下的文字', example: 'Premium' },
  tags: {
    label: '线路标签',
    hint: '标准线路标签，按固定顺序以空格分隔',
    example: 'IEPL 专线 原生',
  },
};

export const FIELD_ORDER: NamingField[] = [
  'emoji',
  'region',
  'region_code',
  'index',
  'route',
  'rate',
  'source',
  'protocol',
  'vendor',
  'entry',
  'note',
  'tags',
];

/** Fields the system assigns itself — always available. */
export const ASSIGNED_FIELDS: ReadonlySet<NamingField> = new Set(['source', 'index']);

export const RULE_FIELDS: Array<{ value: RuleField; label: string }> = [
  { value: 'tag', label: '标签' },
  { value: 'route', label: '线路' },
  { value: 'vendor', label: '服务商' },
  { value: 'region', label: '地区' },
  { value: 'entry', label: '入口' },
];

/** Human value for a health sample (regions arrive as codes). */
export function sampleDisplay(field: NamingField, value: string): string {
  if (field === 'region') return regionByCode(value)?.zh ?? value;
  if (field === 'emoji') return regionByCode(value)?.emoji ?? (flagFromCode(value) || value);
  if (field === 'rate') return /x$/i.test(value) ? value : `${value}x`;
  if (field === 'index') return /^\d+$/.test(value) ? value.padStart(2, '0') : '01';
  return value;
}

export interface FieldStat {
  percent: number;
  present: number;
  total: number;
  low: number;
  sample: string | null;
}

/** Coverage of every field across all sources of the target. */
export function fieldStats(health: SourceHealthReport[]): Map<NamingField, FieldStat> {
  const out = new Map<NamingField, FieldStat>();
  for (const field of FIELD_ORDER) {
    let present = 0;
    let total = 0;
    let low = 0;
    let best: { value: string; count: number } | null = null;
    for (const report of health) {
      const cov = report.fields.find((f) => f.field === field);
      if (!cov) continue;
      present += cov.present;
      total += cov.total;
      low += cov.confidence.low;
      const top = cov.samples[0];
      if (top && (!best || top.count > best.count)) best = { value: top.value, count: top.count };
    }
    out.set(field, {
      percent: total ? Math.round((present / total) * 100) : 0,
      present,
      total,
      low,
      sample: best ? sampleDisplay(field, best.value) : null,
    });
  }
  return out;
}

/* ─── presets ────────────────────────────────────────────────────────── */

export interface Preset {
  id: string;
  label: string;
  hint: string;
  template: string;
}

export function presetsFor(aggregate: boolean, recommended: string): Preset[] {
  const head = '${emoji} ${region} ${index}';
  const source = aggregate ? '${?source: · ${source}}' : '';
  return [
    { id: 'recommended', label: '推荐', hint: '按这个来源的情况推荐', template: recommended },
    { id: 'minimal', label: '精简', hint: '国旗、地区和序号', template: head + source },
    {
      id: 'balanced',
      label: '均衡',
      hint: '再带上线路和倍率',
      template: head + '${?route: · ${route}}${?rate: · ${rate}}' + source,
    },
    {
      id: 'detailed',
      label: '详细',
      hint: '尽量保留识别到的信息',
      template:
        head +
        '${?route: · ${route}}${?vendor: · ${vendor}}${?protocol: · ${protocol:upper}}${?rate: · ${rate}}' +
        source,
    },
  ];
}

const EXAMPLE_CONTEXT = {
  emoji: '🇭🇰',
  region: '香港',
  regionCode: 'HK',
  route: '中转',
  rate: '2x',
  index: '01',
  protocol: 'vless',
  source: 'Nebula',
};

/** Illustrative rendering of a template against a fixed sample node. */
export function exampleName(template: string): string | null {
  const validation = validateTemplate(template);
  if (!validation.ok) return null;
  return renderTemplate(validation.tokens, EXAMPLE_CONTEXT) || null;
}

/* ─── plans ──────────────────────────────────────────────────────────── */

export function activationOf(data: NamingWorkspaceData): Activation {
  if (!data.managed.present) return 'absent';
  return data.managed.disabled ? 'disabled' : 'enabled';
}

/** The stored plan (or the recommendation when nothing is managed yet). */
export function storedPlan(data: NamingWorkspaceData): NamingPlan {
  const m = data.managed;
  return {
    template: m.present && m.template ? m.template : data.recommended,
    tw2cn: m.tw2cn === true,
    sourceAliases: { ...(m.sourceAliases ?? {}) },
    recognitionRules: (m.recognitionRules ?? []).map((r) => ({ ...r })),
    ...(m.nodeFacts !== undefined ? { nodeFacts: m.nodeFacts } : {}),
  };
}

export function cleanAliases(aliases: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliases)) {
    const v = value.trim();
    if (v) out[key] = v;
  }
  return out;
}

const isBlankRule = (r: RecognitionRule) => r.pattern === '' && r.value.trim() === '';

/** The complete, explicit body sent to preview/apply (every policy field present). */
export function planBody(plan: NamingPlan): NamingPlan {
  return {
    ...(plan.nodeFacts !== undefined ? { nodeFacts: plan.nodeFacts } : {}),
    template: plan.template,
    tw2cn: plan.tw2cn,
    sourceAliases: cleanAliases(plan.sourceAliases),
    recognitionRules: plan.recognitionRules
      .filter((r) => !isBlankRule(r))
      .map((r) => ({ pattern: r.pattern, field: r.field, value: r.value.trim() })),
  };
}

export function samePlan(a: NamingPlan, b: NamingPlan): boolean {
  return JSON.stringify(canonical(planBody(a))) === JSON.stringify(canonical(planBody(b)));
}

function canonical(plan: NamingPlan) {
  return {
    ...plan,
    sourceAliases: Object.fromEntries(Object.entries(plan.sourceAliases).sort(([x], [y]) => (x < y ? -1 : 1))),
  };
}

export function ruleError(rule: RecognitionRule): string | null {
  if (rule.field === 'tag' && !LINE_TAGS.some((tag) => tag === rule.value)) return '请选择标准标签';
  if (isBlankRule(rule)) return null;
  if (!rule.pattern) return '填写要匹配的文字';
  if (rule.pattern.length > 100) return '匹配内容最多 100 个字符';
  try {
    new RegExp(rule.pattern, 'i');
  } catch {
    return '不是合法的正则表达式';
  }
  if (!rule.value.trim()) return '填写要设定的值';
  if (rule.value.trim().length > 24) return '值最多 24 个字符';
  return null;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── template structure (for the visual strip) ──────────────────────── */

export type Piece =
  | { kind: 'literal'; text: string; start: number; end: number }
  | { kind: 'field'; field: NamingField; mod?: string; start: number; end: number }
  | { kind: 'optional'; field: NamingField; inner: Piece[]; start: number; end: number };

function placeholderEnd(text: string, start: number): number {
  let depth = 0;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '$') {
      const next = text[i + 1];
      if (next === '$') {
        i += 2;
        continue;
      }
      if (next === '{') {
        depth += 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) return i;
      depth -= 1;
    }
    i += 1;
  }
  return -1;
}

/** Top-level pieces with source spans. Only call on a validated template. */
export function templatePieces(template: string): Piece[] {
  const pieces: Piece[] = [];
  let literal = '';
  let litStart = 0;
  const flush = (end: number) => {
    if (literal) pieces.push({ kind: 'literal', text: literal, start: litStart, end });
    literal = '';
  };
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '$' && template[i + 1] === '{') {
      flush(i);
      const end = placeholderEnd(template, i);
      if (end === -1) break;
      const body = template.slice(i + 2, end);
      if (body.startsWith('?')) {
        const colon = body.indexOf(':');
        pieces.push({
          kind: 'optional',
          field: body.slice(1, colon).trim() as NamingField,
          inner: templatePieces(body.slice(colon + 1)),
          start: i,
          end: end + 1,
        });
      } else {
        const colon = body.indexOf(':');
        pieces.push({
          kind: 'field',
          field: (colon === -1 ? body : body.slice(0, colon)).trim() as NamingField,
          mod: colon === -1 ? undefined : body.slice(colon + 1).trim(),
          start: i,
          end: end + 1,
        });
      }
      i = end + 1;
      continue;
    }
    if (!literal) litStart = i;
    if (ch === '$' && template[i + 1] === '$') {
      literal += '$';
      i += 2;
      continue;
    }
    literal += ch;
    i += 1;
  }
  flush(template.length);
  return pieces;
}

export function tokenFor(field: NamingField, optional: boolean, separator: string): string {
  return optional ? '${?' + field + ':' + separator + '${' + field + '}}' : '${' + field + '}';
}

/** Insert a token at the selection; required fields get a leading space when glued to text. */
export function insertAt(
  template: string,
  start: number,
  end: number,
  token: string,
  required: boolean,
): { next: string; caret: number } {
  const before = template.slice(0, start);
  const after = template.slice(end);
  const glue = required && before !== '' && !/[\s·|\-_/:：,，(（[【]$/.test(before) ? ' ' : '';
  const insert = glue + token;
  return { next: before + insert + after, caret: before.length + insert.length };
}

/* ─── preview rows ───────────────────────────────────────────────────── */

export interface PreviewRow {
  key: string;
  before: string | null;
  after: string | null;
  /** The new name got an automatic suffix to resolve a duplicate. */
  collision: boolean;
  /** Removed as a true duplicate of this kept node. */
  removedFor?: string;
}

export interface IssueSummary {
  collisions: string[];
  dedup: Array<{ kept: string; dropped: string }>;
  orphans: OrphanIssue[];
  duplicates: Array<{ name: string; count: number }>;
}

export function summarizeIssues(issues: PreviewIssue[]): IssueSummary {
  const out: IssueSummary = { collisions: [], dedup: [], orphans: [], duplicates: [] };
  for (const issue of issues) {
    const i = issue as Record<string, unknown>;
    if (issue.code === 'rename-collision-resolved' && typeof i.name === 'string') out.collisions.push(i.name);
    else if (issue.code === 'true-dedup' && typeof i.kept === 'string' && typeof i.dropped === 'string')
      out.dedup.push({ kept: i.kept, dropped: i.dropped });
    else if (issue.code === 'orphaned-reference') out.orphans.push(issue as unknown as OrphanIssue);
    else if (issue.code === 'duplicate-final-name' && typeof i.name === 'string')
      out.duplicates.push({ name: i.name, count: Number(i.count) || 2 });
  }
  return out;
}

const SUFFIX_RE = /^( · .+-\d+)?( #\d+)?$/;

function collidedWith(name: string, collisions: string[]): boolean {
  return collisions.some((c) => {
    if (name === c || !name.startsWith(c)) return false;
    return SUFFIX_RE.test(name.slice(c.length));
  });
}

/**
 * Pair the names configs carry now with the names after the plan. Both lists
 * come out of the same pipeline in the same order, so they pair by position
 * unless a later step re-sorts, or counts differ beyond what true-dedup
 * explains — then we fall back to the new list alone (`paired: false`).
 */
export function buildRows(
  before: NamesPayload | undefined,
  after: NamesPayload,
  summary: IssueSummary,
  reorders: boolean,
): { rows: PreviewRow[]; paired: boolean } {
  const row = (i: number, b: string | null, a: string | null, removedFor?: string): PreviewRow => ({
    key: `${i}:${b ?? ''}:${a ?? ''}`,
    before: b,
    after: a,
    collision: a !== null && collidedWith(a, summary.collisions),
    removedFor,
  });
  const unpaired = () => ({ rows: after.names.map((a, i) => row(i, null, a)), paired: false });
  if (!before || reorders) return unpaired();
  if (before.count === after.count) {
    const n = Math.min(before.names.length, after.names.length);
    return { rows: Array.from({ length: n }, (_, i) => row(i, before.names[i], after.names[i])), paired: true };
  }
  const removed = new Map<number, string>();
  for (const d of summary.dedup) {
    const idx = before.names.findIndex((name, i) => name === d.dropped && !removed.has(i));
    if (idx >= 0) removed.set(idx, d.kept);
  }
  if (before.count - removed.size !== after.count) return unpaired();
  const rows: PreviewRow[] = [];
  let j = 0;
  before.names.forEach((name, i) => {
    if (removed.has(i)) rows.push(row(i, name, null, removed.get(i)));
    else if (j < after.names.length) rows.push(row(i, name, after.names[j++]));
  });
  return { rows, paired: true };
}

export const REF_KIND: Record<string, string> = {
  'proxy-group-member': '策略组',
  'chain-backend': '链式代理',
  'rule-policy': '规则',
};
