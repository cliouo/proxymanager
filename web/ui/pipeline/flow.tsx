'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowRight,
  ArrowUpRight,
  GripVertical,
  Lock,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { OperatorStepTrace, StoredOperator } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Menu, Switch, Tooltip, type MenuEntry } from '@/ui/primitives';
import {
  hasDiagnostic,
  isEditableKind,
  isNamingStep,
  isParked,
  KIND_META,
  KIND_ORDER,
  type EditableStep,
  type StepErrors,
  type StepKind,
} from './model';
import { StepForm } from './step-forms';

/** Horizontal position of the rail — the centre of every icon tile (border + px-3.5 + handle + gap + half tile). */
const RAIL = 'left-[53px]';

/* ─── add-step menu ──────────────────────────────────────────────────── */

const GROUPS: Array<{ heading: string; kinds: StepKind[] }> = [
  { heading: '过滤', kinds: ['filter-useless', 'filter-regex', 'filter-region', 'filter-type'] },
  { heading: '改名', kinds: ['rename-regex', 'flag-emoji'] },
  { heading: '整理', kinds: ['dedup', 'sort', 'set-prop'] },
];

export function addStepItems(onPick: (kind: StepKind) => void, renameAllowed: boolean): MenuEntry[] {
  const entries: MenuEntry[] = [];
  GROUPS.forEach((group, index) => {
    if (index > 0) entries.push('separator');
    entries.push({ heading: group.heading });
    for (const kind of group.kinds) {
      const meta = KIND_META[kind];
      const blocked = !!meta.renames && !renameAllowed;
      entries.push({
        label: meta.title,
        icon: meta.icon,
        disabled: blocked,
        hint: blocked ? '需在智能命名之前' : undefined,
        onSelect: () => onPick(kind),
      });
    }
  });
  return entries;
}

export const ALL_KINDS = KIND_ORDER;

/* ─── terminals ──────────────────────────────────────────────────────── */

export function FlowTerminal({
  icon: Icon,
  title,
  hint,
  count,
  tone = 'start',
  dim,
}: {
  icon: LucideIcon;
  title: ReactNode;
  hint?: ReactNode;
  count: number | null;
  tone?: 'start' | 'end';
  dim?: boolean;
}) {
  const end = tone === 'end';
  return (
    <div
      className={cn(
        'relative flex items-center gap-2 rounded-xl border py-3 pl-3.5 pr-4',
        end ? 'border-transparent bg-inverse text-inverse-ink shadow-sm' : 'border-line bg-surface-2/70',
      )}
    >
      <span className="w-4 shrink-0" aria-hidden />
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg',
          end ? 'bg-inverse-ink/12 text-inverse-ink' : 'border border-line bg-surface text-ink-2 shadow-xs',
        )}
      >
        <Icon size={15} strokeWidth={1.75} />
      </span>
      <div className="ml-1 min-w-0 flex-1">
        <div className={cn('text-[13px] font-medium', end ? 'text-inverse-ink' : 'text-ink')}>{title}</div>
        {hint && <div className={cn('mt-0.5 text-xs', end ? 'text-inverse-ink/65' : 'text-ink-3')}>{hint}</div>}
      </div>
      <span
        className={cn(
          'tnum font-display text-[30px] leading-none tracking-tight transition-opacity',
          end ? 'text-inverse-ink' : 'text-ink',
          dim && 'opacity-40',
        )}
      >
        {count ?? '—'}
      </span>
    </div>
  );
}

/* ─── connector ──────────────────────────────────────────────────────── */

/** The rail between two nodes: its width follows how many nodes flow through. */
export function Connector({
  count,
  max,
  dim,
  insert,
  quiet,
}: {
  count: number | null;
  max: number;
  dim?: boolean;
  /** Menu entries for inserting a step here. */
  insert?: MenuEntry[];
  /** Hide the count + insert affordance (while dragging). */
  quiet?: boolean;
}) {
  const ratio = count !== null && max > 0 ? Math.min(1, count / max) : 0.5;
  const width = 2 + Math.round(ratio * 4);
  return (
    <div className="group/conn relative h-11">
      <span
        aria-hidden
        className={cn('absolute inset-y-0 -translate-x-1/2 rounded-full bg-line-strong transition-[width]', RAIL)}
        style={{ width }}
      />
      {!quiet && (
        <div className={cn('absolute top-1/2 -translate-x-1/2 -translate-y-1/2', RAIL)}>
          <span
            className={cn(
              'tnum relative rounded-full border border-line bg-panel px-1.5 py-px font-mono text-[10.5px] text-ink-3 transition-opacity',
              dim && 'opacity-50',
            )}
            title={count !== null ? `${count} 个节点流过这里` : undefined}
          >
            {count ?? '—'}
          </span>
        </div>
      )}
      {!quiet && insert && (
        <div className="absolute left-[80px] top-1/2 -translate-y-1/2">
          <Menu
            align="start"
            items={insert}
            trigger={
              <button
                type="button"
                aria-label="在这里插入步骤"
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border border-line bg-surface text-ink-3 shadow-xs transition',
                  'opacity-0 hover:border-line-strong hover:text-ink focus-visible:opacity-100 group-hover/conn:opacity-100 data-[state=open]:opacity-100',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                )}
              >
                <Plus size={11} strokeWidth={2.25} />
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}

/* ─── step card ──────────────────────────────────────────────────────── */

function TraceBadges({ trace }: { trace?: OperatorStepTrace }) {
  if (!trace) return null;
  const dropped = Number(trace.dropped ?? 0);
  const changed = Number(trace.changed ?? 0);
  if (trace.applied === false) return null;
  if (!dropped && !changed) {
    return <span className="text-2xs text-ink-4">无变化</span>;
  }
  return (
    <span className="flex items-center gap-1">
      {dropped > 0 && (
        <Tooltip content={`移除了 ${dropped} 个节点`}>
          <span>
            <Badge tone="bad" mono>
              −{dropped}
            </Badge>
          </span>
        </Tooltip>
      )}
      {changed > 0 && (
        <Tooltip content={`修改了 ${changed} 个节点`}>
          <span>
            <Badge tone="accent" mono>
              ~{changed}
            </Badge>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

function Samples({ trace }: { trace?: OperatorStepTrace }) {
  const samples = (trace?.samples as Array<{ before: string; after: string }> | undefined) ?? [];
  const changedPairs = samples.filter((s) => s.before !== s.after).slice(0, 2);
  if (changedPairs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface-2/70 px-2.5 py-2">
      {changedPairs.map((pair, index) => (
        <div key={index} className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="min-w-0 truncate text-ink-3" title={pair.before}>
            {pair.before}
          </span>
          <ArrowRight size={11} className="shrink-0 text-ink-4" />
          <span className="min-w-0 truncate font-medium text-ink" title={pair.after}>
            {pair.after}
          </span>
        </div>
      ))}
    </div>
  );
}

function IconTile({ icon: Icon, tone = 'default' }: { icon: LucideIcon; tone?: 'default' | 'warn' | 'accent' }) {
  return (
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-lg border',
        tone === 'warn' && 'border-warn/30 bg-warn-soft text-warn',
        tone === 'accent' && 'border-accent-line/70 bg-accent-soft text-accent',
        tone === 'default' && 'border-line bg-surface-2 text-ink-2',
      )}
    >
      <Icon size={14} strokeWidth={1.75} />
    </span>
  );
}

export interface StepCardProps {
  op: StoredOperator;
  index: number;
  trace?: OperatorStepTrace;
  errors?: StepErrors;
  serverError?: string;
  namingHref: string;
  /** Rail connector rendered above the card (moves with it while dragging). */
  connector: ReactNode;
  onChange: (patch: Partial<Record<string, unknown>>) => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}

export function StepCard({
  op,
  index,
  trace,
  errors,
  serverError,
  namingHref,
  connector,
  onChange,
  onToggle,
  onRemove,
}: StepCardProps) {
  const parked = isParked(op);
  const naming = isNamingStep(op);
  const flagged = !parked && hasDiagnostic(op);
  const movable = !parked && !naming;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: op.id,
    disabled: !movable,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    position: 'relative',
  };

  const handle = movable ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`拖动第 ${index + 1} 步调整顺序`}
      className="mt-1.5 flex h-4 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-4 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
    >
      <GripVertical size={14} />
    </button>
  ) : (
    <span className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center text-ink-4" aria-hidden>
      {naming ? <Lock size={11} /> : null}
    </span>
  );

  let body: ReactNode;
  if (parked) {
    body = (
      <div className="flex items-start gap-2 px-3.5 py-3">
        {handle}
        <IconTile icon={TriangleAlert} tone="warn" />
        <div className="ml-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            无法识别的历史步骤
            <Badge tone="warn">已停用</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">
            这一步来自旧版本，现在已无法解析。它不会执行，也不会被悄悄删掉；删除它之后才能保存处理流程。
          </p>
        </div>
        <Tooltip content="删除这一步">
          <Button size="sm" variant="ghost" iconOnly icon={Trash2} aria-label="删除这一步" onClick={onRemove} />
        </Tooltip>
      </div>
    );
  } else if (naming) {
    body = (
      <div className="flex items-start gap-2 px-3.5 py-3">
        {handle}
        <IconTile icon={Sparkles} tone="accent" />
        <div className="ml-1 min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-ink">
            智能命名
            {op.disabled && <Badge>已停用</Badge>}
            {flagged && <Badge tone="warn">未通过校验</Badge>}
            <TraceBadges trace={trace} />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            统一整理节点名称（地区、线路、序号）。它是最后的改名步骤，位置固定，只能在命名工作台中修改。
          </p>
          <Link
            href={namingHref}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline underline-offset-4"
          >
            在命名工作台中编辑
            <ArrowUpRight size={12} />
          </Link>
        </div>
      </div>
    );
  } else if (isEditableKind(op.kind)) {
    const step = op as EditableStep;
    const meta = KIND_META[step.kind];
    const off = !!op.disabled;
    body = (
      <>
        {flagged && (
          <div className="flex items-start gap-2 rounded-t-xl border-b border-warn/25 bg-warn-soft px-3.5 py-2 text-xs leading-relaxed text-warn">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            这一步是旧版本保存的，不符合现在的安全校验，已自动停用（不会执行）。改好设置后即可重新启用，或者直接删除。
          </div>
        )}
        <div className="flex items-start gap-2 px-3.5 pt-3">
          {handle}
          <IconTile icon={meta.icon} />
          <div className="ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 pt-1">
            <span className={cn('text-[13px] font-medium', off ? 'text-ink-3' : 'text-ink')}>{meta.title}</span>
            {off ? <Badge>已停用</Badge> : <TraceBadges trace={trace} />}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip content={flagged ? '先修改设置，通过校验后才能启用' : off ? '启用这一步' : '停用这一步（保留设置）'}>
              <span className="flex items-center px-1">
                <Switch
                  size="sm"
                  checked={!off}
                  disabled={flagged}
                  label={off ? `启用「${meta.title}」` : `停用「${meta.title}」`}
                  onCheckedChange={onToggle}
                />
              </span>
            </Tooltip>
            <Tooltip content="删除这一步">
              <Button size="sm" variant="ghost" iconOnly icon={Trash2} aria-label={`删除「${meta.title}」`} onClick={onRemove} />
            </Tooltip>
          </div>
        </div>
        <div className={cn('flex flex-col gap-3 px-3.5 pb-3.5 pt-2.5 sm:pl-[64px]', off && 'opacity-60')}>
          <StepForm op={step} onChange={onChange} errors={errors} />
          {errors?.order && <p className="text-xs leading-relaxed text-bad">{errors.order}</p>}
          {serverError && <p className="text-xs leading-relaxed text-bad">{serverError}</p>}
          {!off && <Samples trace={trace} />}
        </div>
      </>
    );
  } else {
    body = (
      <div className="flex items-start gap-2 px-3.5 py-3">
        {handle}
        <IconTile icon={TriangleAlert} tone="warn" />
        <div className="ml-1 min-w-0 flex-1 text-[13px] text-ink">
          未知步骤 <span className="font-mono text-xs text-ink-3">{String(op.kind)}</span>
        </div>
        <Button size="sm" variant="ghost" iconOnly icon={Trash2} aria-label="删除这一步" onClick={onRemove} />
      </div>
    );
  }

  return (
    <li ref={setNodeRef} style={style} className="list-none">
      {connector}
      <div
        className={cn(
          'animate-rise rounded-xl border bg-surface shadow-xs transition-[box-shadow,border-color]',
          parked || flagged ? 'border-warn/35' : naming ? 'border-accent-line/70' : 'border-line',
          isDragging && 'shadow-lg ring-1 ring-accent-line',
          (errors?.pattern || errors?.order || serverError) && !parked && 'border-bad/40',
        )}
      >
        {body}
      </div>
    </li>
  );
}
