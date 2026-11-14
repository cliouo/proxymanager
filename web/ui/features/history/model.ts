import { diffLines } from 'diff';
import type { AuditEvent } from '@/ui/data/types';
import { opLabel } from '@/ui/lib/ops';
import { toMs } from '@/ui/lib/format';

/** Ops the backend records that `ui/lib/ops.ts` has no label for yet. */
const EXTRA_LABELS: Record<string, string> = {
  'rule-anchor-append.update': '修改规则',
  'rule-provider.update': '修改规则集',
  'tailscale.enable': '启用设备 Tailscale',
  'tailscale.disable': '停用设备 Tailscale',
  'config-section.delete-section': '删除配置分组',
};

export const eventTitle = (op: string) => EXTRA_LABELS[op] ?? opLabel(op);

/** Mirrors the server's undo gate; the server still has the final say (no inverse → 422). */
export function canUndo(event: AuditEvent): boolean {
  const kind = event.target?.kind;
  return event.undoable !== false && !event.undone_by && kind !== 'profile' && kind !== 'naming-source';
}

export type Snapshot = Record<string, unknown>;

export function snapshot(value: unknown): Snapshot | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Snapshot) : null;
}

export const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/* ─── days & times ───────────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(ts: number): string {
  const d = new Date(toMs(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function dayLabel(ts: number, now: number): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return '今天';
  if (key === dayKey(now - 86_400_000)) return '昨天';
  const d = new Date(toMs(ts));
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${sameYear ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

export function clockTime(ts: number): string {
  const d = new Date(toMs(ts));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function exactTime(ts: number): string {
  const d = new Date(toMs(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ─── diff ───────────────────────────────────────────────────────────── */

export interface DiffLine {
  kind: 'add' | 'del' | 'same' | 'gap';
  text: string;
}

const pretty = (value: unknown) => (value === undefined || value === null ? '' : `${JSON.stringify(value, null, 2)}\n`);

/** Line diff of the pretty JSON snapshots; long unchanged runs fold to a "n 行未变" marker. */
export function snapshotDiff(before: unknown, after: unknown, context = 3): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(pretty(before), pretty(after))) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    if (part.added || part.removed) {
      for (const text of lines) out.push({ kind: part.added ? 'add' : 'del', text });
      continue;
    }
    if (lines.length > context * 2 + 2) {
      for (const text of lines.slice(0, context)) out.push({ kind: 'same', text });
      out.push({ kind: 'gap', text: `${lines.length - context * 2} 行未变` });
      for (const text of lines.slice(-context)) out.push({ kind: 'same', text });
    } else {
      for (const text of lines) out.push({ kind: 'same', text });
    }
  }
  return out;
}

export function actorLabel(actor: string): string {
  if (actor === 'admin') return '管理员';
  if (/assistant|ai|agent|mcp/i.test(actor)) return 'AI 助手';
  return actor;
}
