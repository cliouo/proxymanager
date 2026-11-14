/**
 * Pure helpers for the node-processing pipeline editor (节点处理). Mirrors the
 * server contract in `schemas/operator.ts` + `lib/services/operatorMutationPolicy.ts`
 * without importing runtime values from `@/schemas` (that would drag zod in).
 */
import {
  ArrowDownUp,
  CopyMinus,
  Earth,
  Eraser,
  Flag,
  Funnel,
  Network,
  Replace,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import type { Operator, StoredOperator } from '@/ui/data/types';

/* ─── kinds ──────────────────────────────────────────────────────────── */

export type StepKind =
  | 'filter-useless'
  | 'filter-regex'
  | 'filter-region'
  | 'filter-type'
  | 'rename-regex'
  | 'flag-emoji'
  | 'dedup'
  | 'sort'
  | 'set-prop';

export type EditableStep = Extract<Operator, { kind: StepKind }>;
export type StepOf<K extends StepKind> = Extract<Operator, { kind: K }>;

export interface KindMeta {
  kind: StepKind;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Renames nodes — not allowed after an enabled 智能命名 step. */
  renames?: boolean;
}

export const KIND_META: Record<StepKind, KindMeta> = {
  'filter-useless': {
    kind: 'filter-useless',
    title: '去除无用节点',
    description: '删掉「剩余流量」「官网」这类只用来展示信息的节点',
    icon: Eraser,
  },
  'filter-regex': {
    kind: 'filter-regex',
    title: '正则过滤',
    description: '按名称匹配，保留或删除节点',
    icon: Funnel,
  },
  'filter-region': {
    kind: 'filter-region',
    title: '地区过滤',
    description: '只保留或去掉某些国家和地区',
    icon: Earth,
  },
  'filter-type': {
    kind: 'filter-type',
    title: '协议过滤',
    description: '按协议类型保留或删除节点',
    icon: Network,
  },
  'rename-regex': {
    kind: 'rename-regex',
    title: '正则重命名',
    description: '替换名称里的文字，替换内容留空即删除',
    icon: Replace,
    renames: true,
  },
  'flag-emoji': {
    kind: 'flag-emoji',
    title: '国旗',
    description: '在名称前加上或去掉国旗',
    icon: Flag,
    renames: true,
  },
  dedup: {
    kind: 'dedup',
    title: '去重',
    description: '处理同名或同一服务器的重复节点',
    icon: CopyMinus,
  },
  sort: {
    kind: 'sort',
    title: '排序',
    description: '按名称、协议、服务器或地区排序',
    icon: ArrowDownUp,
  },
  'set-prop': {
    kind: 'set-prop',
    title: '设置属性',
    description: '统一打开或关闭 UDP、TFO、跳过证书验证',
    icon: SlidersHorizontal,
  },
};

/** Order shown in the "添加步骤" menu: filters, renames, then housekeeping. */
export const KIND_ORDER: StepKind[] = [
  'filter-useless',
  'filter-regex',
  'filter-region',
  'filter-type',
  'rename-regex',
  'flag-emoji',
  'dedup',
  'sort',
  'set-prop',
];

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

export const MAX_STEPS = 64;
const MAX_PATTERN = 512;

export function newStepId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createStep(kind: StepKind): EditableStep {
  const id = newStepId();
  switch (kind) {
    case 'filter-useless':
      return { id, kind, extra: [] };
    case 'filter-regex':
      return { id, kind, mode: 'keep', pattern: '', flags: 'i' };
    case 'filter-region':
      return { id, kind, mode: 'keep', regions: [] };
    case 'filter-type':
      return { id, kind, mode: 'keep', types: [] };
    case 'rename-regex':
      return { id, kind, pattern: '', replacement: '', flags: 'g' };
    case 'flag-emoji':
      return { id, kind, action: 'add' };
    case 'dedup':
      return { id, kind, by: 'name', action: 'rename' };
    case 'sort':
      return { id, kind, by: 'name', order: 'asc' };
    case 'set-prop':
      return { id, kind };
  }
}

/* ─── classification ─────────────────────────────────────────────────── */

export const PARKED_KIND = '__incompatible__';

export function isParked(op: StoredOperator): boolean {
  return (op as { kind: string }).kind === PARKED_KIND;
}

/** A stored step that failed the current runtime checks (kept, disabled, never runs). */
export function hasDiagnostic(op: StoredOperator): boolean {
  return Object.hasOwn(op as object, 'compatibility_issue');
}

export function isNamingStep(op: StoredOperator): boolean {
  return op.kind === 'rename-template';
}

export function isEditableKind(kind: string): kind is StepKind {
  return kind in KIND_META;
}

/** Steps the user may drag (never 智能命名 or undecodable history). */
export function isMovable(op: StoredOperator): boolean {
  return !isParked(op) && !isNamingStep(op);
}

/** Index of the managed 智能命名 row (first current-valid rename-template), or -1. */
export function managedNamingIndex(ops: StoredOperator[]): number {
  return ops.findIndex((op) => isNamingStep(op) && !hasDiagnostic(op));
}

/**
 * The server rejects any reorder that moves a surviving step across the managed
 * 智能命名 row; same-side reorders are fine.
 */
export function crossesNaming(prev: StoredOperator[], next: StoredOperator[]): boolean {
  const index = managedNamingIndex(prev);
  if (index < 0) return false;
  const namingId = prev[index].id;
  const nextIndex = next.findIndex((op) => op.id === namingId);
  const before = new Set(prev.slice(0, index).map((op) => op.id));
  const after = new Set(next.slice(0, nextIndex).map((op) => op.id));
  return before.size !== after.size || [...before].some((id) => !after.has(id));
}

/** Where a new step of `kind` should go when appended: rename steps must run before 智能命名. */
export function appendIndex(ops: StoredOperator[], kind: StepKind): number {
  const naming = ops.findIndex((op) => isNamingStep(op) && !op.disabled && !hasDiagnostic(op));
  if (KIND_META[kind].renames && naming >= 0) return naming;
  return ops.length;
}

/** Can a rename-capable step be inserted at `index`? */
export function renameAllowedAt(ops: StoredOperator[], index: number): boolean {
  const naming = ops.findIndex((op) => isNamingStep(op) && !op.disabled && !hasDiagnostic(op));
  return naming < 0 || index <= naming;
}

/* ─── validation ─────────────────────────────────────────────────────── */

export type StepErrors = Partial<Record<'pattern' | 'replacement' | 'extra' | 'order', string>>;

export function regexProblem(pattern: string, flags?: string): string | null {
  if (!pattern) return '请填写正则表达式';
  if (pattern.length > MAX_PATTERN) return '正则过长（最多 512 个字符）';
  try {
    new RegExp(pattern, (flags ?? '').replace(/[gy]/g, ''));
  } catch {
    return '不是合法的正则表达式';
  }
  return null;
}

/** `filter-useless` fragments are OR-ed into one pattern; an empty-matching one would drop everything. */
export function uselessFragmentProblem(fragment: string): string | null {
  const basic = regexProblem(fragment);
  if (basic) return basic;
  try {
    if (new RegExp(fragment).test('')) return '不能匹配空字符串（会误删全部节点）';
  } catch {
    return '不是合法的正则表达式';
  }
  return null;
}

export function validateSteps(ops: StoredOperator[]): Record<string, StepErrors> {
  const out: Record<string, StepErrors> = {};
  let namingActive = false;
  for (const op of ops) {
    if (isParked(op) || hasDiagnostic(op)) continue;
    const errors: StepErrors = {};
    switch (op.kind) {
      case 'filter-regex': {
        const problem = regexProblem(op.pattern, op.flags ?? 'i');
        if (problem) errors.pattern = problem;
        break;
      }
      case 'rename-regex': {
        const problem = regexProblem(op.pattern, op.flags ?? 'g');
        if (problem) errors.pattern = problem;
        if ((op.replacement ?? '').length > MAX_PATTERN) errors.replacement = '替换内容过长';
        break;
      }
      case 'filter-useless': {
        const bad = (op.extra ?? []).map(uselessFragmentProblem).find(Boolean);
        if (bad) errors.extra = bad;
        break;
      }
      default:
        break;
    }
    if (op.kind === 'rename-template') {
      if (!op.disabled) namingActive = true;
    } else if (namingActive && !op.disabled) {
      if ((op.kind === 'rename-regex' && op.pattern.trim() !== '') || op.kind === 'flag-emoji') {
        errors.order = '「智能命名」已是最后的改名步骤，之后不能再改名。请停用这一步，或删除后在智能命名之前重新添加。';
      }
    }
    if (Object.keys(errors).length > 0) out[op.id] = errors;
  }
  return out;
}

/** What actually gets sent: undecodable history is never sendable; diagnostics are stripped. */
export function saveCandidate(ops: StoredOperator[]): Operator[] {
  return ops
    .filter((op) => !isParked(op))
    .map((op) => {
      if (!hasDiagnostic(op)) return op as Operator;
      const rest = { ...(op as Operator & { compatibility_issue?: string }) };
      delete rest.compatibility_issue;
      return rest as Operator;
    });
}

/** Preview runs only executable rows; parked / runtime-invalid rows never run anyway. */
export function previewCandidate(ops: StoredOperator[]): Operator[] {
  return ops.filter((op) => !isParked(op) && !hasDiagnostic(op)) as Operator[];
}

export function saveBlockReason(ops: StoredOperator[], errors: Record<string, StepErrors>): string | null {
  const parked = ops.filter(isParked).length;
  if (parked > 0) return `有 ${parked} 个无法识别的历史步骤，删除后才能保存`;
  const flagged = ops.filter((op) => !isParked(op) && hasDiagnostic(op)).length;
  if (flagged > 0) return `有 ${flagged} 个步骤未通过当前校验，修改或删除后才能保存`;
  if (ops.length > MAX_STEPS) return `最多 ${MAX_STEPS} 个步骤，请删除 ${ops.length - MAX_STEPS} 个`;
  if (Object.keys(errors).length > 0) return '有步骤还没填写完整或有误，修正后才能保存';
  return null;
}

/* ─── flags helpers ──────────────────────────────────────────────────── */

export function hasFlag(flags: string | undefined, fallback: string, flag: string): boolean {
  return (flags ?? fallback).includes(flag);
}

export function toggleFlag(flags: string | undefined, fallback: string, flag: string, on: boolean): string {
  const current = (flags ?? fallback).replace(flag, '');
  return on ? `${current}${flag}` : current;
}

/* ─── preview issues ─────────────────────────────────────────────────── */

export const REFERENCE_KIND_LABEL: Record<string, string> = {
  'chain-backend': '链式代理',
  'proxy-group-member': '策略组',
  'rule-policy': '规则',
};
