/**
 * Display helpers for the assistant: a light YAML-like dump for tool data
 * (display only — never parsed back), bounded previews, and normalisation of
 * the write-preview diffs produced by the server actions
 * (`lib/ai/actions/primitives/*` → `{ op, path?, before?/after?, beforeYaml?/afterYaml?, … }`).
 */

import { diffLines } from 'diff';

/* ─── YAML-ish dump ──────────────────────────────────────────────────── */

const RESERVED = /^(?:true|false|null|~|yes|no|on|off|[-+]?(?:\d[\d_]*)?\.?\d+(?:e[-+]?\d+)?)$/i;

function inline(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[]';
  if (typeof value === 'object') return '{}';
  if (typeof value !== 'string') return String(value);
  if (value === '') return "''";
  const plain =
    !RESERVED.test(value) &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/\s$/.test(value) &&
    !/:\s|\s#/.test(value);
  return plain ? value : JSON.stringify(value);
}

function keyText(key: string): string {
  return /^[\p{L}\p{N}_.\-/]+$/u.test(key) ? key : JSON.stringify(key);
}

const isEmptyContainer = (value: object) =>
  Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;

function block(text: string, pad: string): string[] {
  return text.replace(/\n$/, '').split('\n').map((line) => `${pad}${line}`);
}

function lines(value: unknown, pad: string): string[] {
  if (typeof value === 'string' && value.includes('\n')) return block(value, pad);
  if (value === null || typeof value !== 'object' || isEmptyContainer(value)) return [`${pad}${inline(value)}`];
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.includes('\n')) {
        out.push(`${pad}- |`, ...block(item, `${pad}    `));
      } else if (item === null || typeof item !== 'object' || isEmptyContainer(item)) {
        out.push(`${pad}- ${inline(item)}`);
      } else {
        const nested = lines(item, `${pad}  `);
        out.push(`${pad}- ${nested[0].slice(pad.length + 2)}`, ...nested.slice(1));
      }
    }
    return out;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const k = keyText(key);
    if (typeof item === 'string' && item.includes('\n')) {
      out.push(`${pad}${k}: |`, ...block(item, `${pad}  `));
    } else if (item === null || typeof item !== 'object' || isEmptyContainer(item)) {
      out.push(`${pad}${k}: ${inline(item)}`);
    } else {
      out.push(`${pad}${k}:`, ...lines(item, `${pad}  `));
    }
  }
  return out;
}

/** Readable, YAML-flavoured text for arbitrary JSON data. */
export function toYamlish(value: unknown): string {
  if (typeof value === 'string') return value;
  return lines(value, '').join('\n');
}

/** Bounded preview text for a tool result (always plain text — never markup). */
export function previewText(data: unknown, max = 6000): string {
  const text = toYamlish(data);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（内容较长，已截断，共 ${text.length.toLocaleString('zh-CN')} 字符）`;
}

export function formatSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/* ─── write-preview diffs ────────────────────────────────────────────── */

export interface RuleShape {
  type: string;
  value: string;
  policy: string;
  anchor?: string;
  options?: string[];
  enabled?: boolean;
}

export type DiffTone = 'add' | 'update' | 'delete' | 'other';

export interface NormalizedDiff {
  tone: DiffTone;
  opLabel: string;
  path: string | null;
  before: string | null;
  after: string | null;
  /** Set when before/after are rule records — rendered as rule lines. */
  rule: { before: RuleShape | null; after: RuleShape | null } | null;
  facts: Array<{ label: string; value: string }>;
}

const OP_META: Record<string, { tone: DiffTone; label: string }> = {
  add: { tone: 'add', label: '新增' },
  create: { tone: 'add', label: '新增' },
  update: { tone: 'update', label: '修改' },
  'batch-update': { tone: 'update', label: '批量修改' },
  delete: { tone: 'delete', label: '删除' },
};

const FACT_LABELS: Record<string, string> = {
  beforeCount: '原步骤数',
  afterCount: '新步骤数',
  template: '命名模板',
  mode: '方式',
  recognitionRuleCount: '识别规则',
  aliasCount: '来源别名',
  operatorCount: '处理步骤',
};

const HIDDEN_KEYS = new Set(['op', 'path', 'before', 'after', 'beforeYaml', 'afterYaml', 'concurrency', 'managedRowId']);

function asRule(value: unknown): RuleShape | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.type !== 'string' || typeof r.policy !== 'string') return null;
  return {
    type: r.type,
    value: typeof r.value === 'string' ? r.value : '',
    policy: r.policy,
    anchor: typeof r.anchor === 'string' ? r.anchor : undefined,
    options: Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string') : undefined,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : undefined,
  };
}

function sideText(record: Record<string, unknown>, side: 'before' | 'after'): string | null {
  const yaml = record[`${side}Yaml`];
  if (typeof yaml === 'string') return yaml;
  if (side in record && record[side] !== undefined) return toYamlish(record[side]);
  return null;
}

export function normalizeDiff(diff: unknown): NormalizedDiff {
  const record = diff && typeof diff === 'object' && !Array.isArray(diff) ? (diff as Record<string, unknown>) : {};
  const op = typeof record.op === 'string' ? record.op : '';
  const meta = OP_META[op] ?? { tone: 'other' as const, label: op.startsWith('repair') ? '修复' : '变更' };
  const ruleBefore = asRule(record.before);
  const ruleAfter = asRule(record.after);
  const isRule = (ruleBefore || ruleAfter) && !('beforeYaml' in record) && !('afterYaml' in record);
  const facts: NormalizedDiff['facts'] = [];
  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    facts.push({ label: FACT_LABELS[key] ?? key, value: String(value) });
  }
  return {
    tone: meta.tone,
    opLabel: meta.label,
    path: typeof record.path === 'string' && record.path ? record.path : null,
    before: isRule ? null : sideText(record, 'before'),
    after: isRule ? null : sideText(record, 'after'),
    rule: isRule ? { before: ruleBefore, after: ruleAfter } : null,
    facts,
  };
}

/* ─── line diff with folded context ──────────────────────────────────── */

export type DiffRow =
  | { type: 'add' | 'del' | 'ctx'; text: string }
  | { type: 'gap'; count: number };

const CONTEXT = 2;

function splitLines(value: string): string[] {
  const parts = value.replace(/\n$/, '').split('\n');
  return parts.length === 1 && parts[0] === '' ? [] : parts;
}

/** Unified line diff of two texts; unchanged runs longer than the context fold into a gap. */
export function lineDiff(before: string | null, after: string | null): DiffRow[] {
  if (before === null && after === null) return [];
  if (before === null) return splitLines(after ?? '').map((text) => ({ type: 'add' as const, text }));
  if (after === null) return splitLines(before).map((text) => ({ type: 'del' as const, text }));
  const rows: Array<{ type: 'add' | 'del' | 'ctx'; text: string }> = [];
  for (const change of diffLines(before, after)) {
    const type = change.added ? 'add' : change.removed ? 'del' : 'ctx';
    for (const text of splitLines(change.value)) rows.push({ type, text });
  }
  const changed = rows.map((row) => row.type !== 'ctx');
  if (!changed.some(Boolean)) return rows;
  const keep = rows.map((_, i) => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (changed[i + d]) return true;
    return false;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: 'gap', count: skipped });
      skipped = 0;
      out.push(row);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: 'gap', count: skipped });
  return out;
}
