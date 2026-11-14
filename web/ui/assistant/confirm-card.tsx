'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Ban, Check, ChevronRight, CircleCheck, CircleHelp, CircleX, Clock, RotateCcw, ShieldCheck } from 'lucide-react';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Spinner } from '@/ui/primitives';
import { PolicyChip } from '@/ui/viz/lines';
import { lineDiff, normalizeDiff, type DiffRow, type NormalizedDiff, type RuleShape } from './format';
import { toolLabel } from './labels';
import type { ConfirmItem, ConfirmStatus } from './session';

/* ─── diff rendering ─────────────────────────────────────────────────── */

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

function DiffLines({ rows }: { rows: DiffRow[] }) {
  if (!rows.length) return <p className="px-3 py-2 text-xs text-ink-3">没有可展示的内容差异。</p>;
  return (
    <div className="max-h-72 overflow-auto py-1 font-mono text-[11.5px] leading-[1.65]">
      {rows.map((row, i) =>
        row.type === 'gap' ? (
          <div key={i} className="select-none px-3 py-0.5 text-2xs text-ink-4">
            ⋯ {row.count} 行未改动
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              'flex gap-2 px-3',
              row.type === 'add' && 'bg-ok-soft text-ink',
              row.type === 'del' && 'bg-bad-soft text-ink-2',
              row.type === 'ctx' && 'text-ink-3',
            )}
          >
            <span
              aria-hidden
              className={cn('w-2.5 shrink-0 select-none', row.type === 'add' ? 'text-ok' : row.type === 'del' ? 'text-bad' : '')}
            >
              {SIGN[row.type]}
            </span>
            <span className="sr-only">{row.type === 'add' ? '新增：' : row.type === 'del' ? '删除：' : ''}</span>
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  );
}

function RuleLine({ rule, tone }: { rule: RuleShape; tone: 'add' | 'del' }) {
  const head = rule.type === 'MATCH' ? 'MATCH' : `${rule.type},${rule.value}${rule.options?.length ? `,${rule.options.join(',')}` : ''}`;
  return (
    <div className={cn('flex items-center gap-2 px-3 py-2', tone === 'add' ? 'bg-ok-soft' : 'bg-bad-soft')}>
      <span aria-hidden className={cn('w-2.5 shrink-0 font-mono text-xs', tone === 'add' ? 'text-ok' : 'text-bad')}>
        {tone === 'add' ? '+' : '−'}
      </span>
      <span className="sr-only">{tone === 'add' ? '改为：' : '原来：'}</span>
      <span className="min-w-0 flex-1 font-mono text-[11.5px] text-ink [overflow-wrap:anywhere]">{head}</span>
      <span aria-hidden className="text-2xs text-ink-4">→</span>
      <PolicyChip policy={rule.policy} size="sm" className="max-w-[40%]" />
      {rule.enabled === false && <Badge tone="neutral">停用</Badge>}
    </div>
  );
}

function DiffView({ diff }: { diff: NormalizedDiff }) {
  const rows = useMemo(() => (diff.rule ? [] : lineDiff(diff.before, diff.after)), [diff]);
  const anchor = diff.rule?.after?.anchor ?? diff.rule?.before?.anchor;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-sunken">
      <div className="flex min-w-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <Badge tone={diff.tone === 'add' ? 'ok' : diff.tone === 'delete' ? 'bad' : 'accent'}>{diff.opLabel}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-3" title={diff.path ?? undefined}>
          {diff.path ?? (anchor ? `rules · 锚点 ${anchor}` : '')}
        </span>
      </div>
      {diff.rule ? (
        <div className="divide-y divide-line">
          {diff.rule.before && <RuleLine rule={diff.rule.before} tone="del" />}
          {diff.rule.after && <RuleLine rule={diff.rule.after} tone="add" />}
        </div>
      ) : (
        <DiffLines rows={rows} />
      )}
      {diff.facts.length > 0 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-2xs">
          {diff.facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 gap-1.5">
              <dt className="text-ink-3">{fact.label}</dt>
              <dd className="truncate font-mono text-ink-2">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* ─── card ───────────────────────────────────────────────────────────── */

function useRemaining(expiresAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return expiresAt - now;
}

const formatClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const HEAD: Record<ConfirmStatus, { title: string; icon: typeof ShieldCheck; tone: string }> = {
  pending: { title: '需要你确认', icon: ShieldCheck, tone: 'text-accent' },
  confirming: { title: '正在执行…', icon: ShieldCheck, tone: 'text-accent' },
  done: { title: '已执行', icon: CircleCheck, tone: 'text-ok' },
  unknown: { title: '结果未知', icon: CircleHelp, tone: 'text-warn' },
  failed: { title: '执行失败', icon: CircleX, tone: 'text-bad' },
  cancelled: { title: '已取消', icon: Ban, tone: 'text-ink-3' },
  expired: { title: '确认已过期', icon: Clock, tone: 'text-ink-3' },
};

export function ConfirmCard({
  item,
  profileLabel,
  onConfirm,
  onCancel,
  onExpire,
  onReissue,
}: {
  item: ConfirmItem;
  profileLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  onExpire: () => void;
  onReissue: () => void;
}) {
  const remaining = useRemaining(item.expiresAt, item.status === 'pending');
  const lapsed = item.status === 'pending' && remaining <= 0;
  const status: ConfirmStatus = lapsed ? 'expired' : item.status;
  const open = status === 'pending' || status === 'confirming';
  const diff = useMemo(() => normalizeDiff(item.diff), [item.diff]);
  const [showDiff, setShowDiff] = useState(false);
  const head = HEAD[status];
  const Icon = head.icon;

  useEffect(() => {
    if (lapsed) onExpire();
  }, [lapsed, onExpire]);

  return (
    <section
      aria-label={`写操作确认：${toolLabel(item.name)}`}
      className={cn(
        'overflow-hidden rounded-xl border bg-surface shadow-xs transition-[border-color,box-shadow]',
        open ? 'border-accent-line shadow-sm' : 'border-line',
      )}
    >
      <header className="flex items-center gap-2 px-3.5 pb-1 pt-3">
        {status === 'confirming' ? <Spinner size={15} className="text-accent" /> : <Icon size={15} strokeWidth={1.9} className={head.tone} />}
        <span className="text-sm font-semibold text-ink">{head.title}</span>
        <span className="min-w-0 truncate text-2xs text-ink-3">· {toolLabel(item.name)}</span>
        <span className="flex-1" />
        {status === 'pending' && (
          <span
            className={cn('tnum shrink-0 text-2xs', remaining < 60_000 ? 'text-warn' : 'text-ink-3')}
            title="确认卡 5 分钟内有效"
          >
            {formatClock(remaining)} 后失效
          </span>
        )}
      </header>

      <div className="flex flex-col gap-3 px-3.5 pb-3.5 pt-1">
        <p className="text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">{item.summary}</p>
        {open && <p className="-mt-2 text-2xs text-ink-3">在配置文件「{profileLabel}」中发起，确认后立即生效。</p>}

        {open ? (
          <DiffView diff={diff} />
        ) : (
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            aria-expanded={showDiff}
            className="-mt-1 inline-flex w-fit items-center gap-1 rounded-md text-2xs text-ink-3 hover:text-ink-2"
          >
            <ChevronRight size={12} className={cn('transition-transform', showDiff && 'rotate-90')} />
            {showDiff ? '收起改动' : '查看改动'}
          </button>
        )}
        {!open && showDiff && <DiffView diff={diff} />}

        <div aria-live="polite" className="empty:hidden">
          {status === 'done' && (
            <p className="text-xs leading-relaxed text-ink-2">
              {item.result && item.result !== item.summary ? `${item.result}。` : '改动已生效。'}
              {item.undoable && (
                <>
                  {' '}可在
                  <Link href="/history" className="mx-0.5 text-accent hover:underline">
                    历史记录
                  </Link>
                  里撤销。
                </>
              )}
            </p>
          )}
          {status === 'unknown' && (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs leading-relaxed text-ink-2">
              服务器没有返回明确结果，这项改动可能已生效，也可能没有。请先到对应页面刷新核对，不要重复执行。
              {item.error ? `（${item.error}）` : ''}
            </p>
          )}
          {status === 'failed' && (
            <div className="rounded-lg bg-bad-soft px-3 py-2 text-xs leading-relaxed text-ink-2">
              <p>{item.error ?? '执行失败'}，没有做任何改动。</p>
              {item.issues && item.issues.length > 1 && (
                <ul className="mt-1 list-disc pl-4 text-ink-3">
                  {item.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {status === 'cancelled' && <p className="text-xs text-ink-3">你取消了这项改动，没有做任何修改。</p>}
          {status === 'expired' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-3">确认卡 5 分钟内有效，已超时，没有执行。</p>
              <Button size="xs" variant="secondary" icon={RotateCcw} onClick={onReissue}>
                重新发起
              </Button>
            </div>
          )}
        </div>
      </div>

      {open && (
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-3.5 py-2.5">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={status === 'confirming'}>
            取消
          </Button>
          <Button size="sm" variant="primary" icon={Check} onClick={onConfirm} loading={status === 'confirming'}>
            确认执行
          </Button>
        </footer>
      )}
    </section>
  );
}
