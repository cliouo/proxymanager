'use client';

import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, Copy, GripVertical, MoreHorizontal, Pencil, SquareCheck, Trash2 } from 'lucide-react';
import type { Rule } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Checkbox, Menu, Switch, Tooltip } from '@/ui/primitives';
import { isBuiltinPolicy, PolicyChip } from '@/ui/viz/lines';
import { RULE_TYPES } from './rule-model';

export interface RuleRowProps {
  rule: Rule;
  position: number | null;
  color: string;
  first: boolean;
  last: boolean;
  selected: boolean;
  selecting: boolean;
  flash: boolean;
  draggable: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: (id: string, shift: boolean) => void;
  onOpen: (rule: Rule) => void;
  onToggle: (rule: Rule, enabled: boolean) => void;
  onMove: (rule: Rule, direction: 'up' | 'down') => void;
  onDelete: (rule: Rule) => void;
  onDuplicate: (rule: Rule) => void;
}

export const RuleRow = memo(function RuleRow({
  rule,
  position,
  color,
  first,
  last,
  selected,
  selecting,
  flash,
  draggable,
  canMoveUp,
  canMoveDown,
  onSelect,
  onOpen,
  onToggle,
  onMove,
  onDelete,
  onDuplicate,
}: RuleRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.id,
    disabled: !draggable,
  });
  const enabled = rule.enabled !== false;
  const meta = RULE_TYPES[rule.type];

  return (
    <li
      ref={setNodeRef}
      id={`rule-${rule.id}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'group relative grid grid-cols-[28px_minmax(0,1fr)] items-stretch',
        isDragging && 'z-20 rounded-lg bg-surface shadow-lg ring-1 ring-line',
      )}
    >
      {/* the rail */}
      <div className="relative flex justify-center" aria-hidden>
        <span
          className={cn('absolute left-1/2 w-[2px] -translate-x-1/2 bg-line-strong/80', first ? 'top-1/2' : 'top-0', last ? 'bottom-1/2' : 'bottom-0')}
        />
        <span
          className="relative z-10 mt-[17px] size-[11px] rounded-full ring-[3px] ring-panel transition-transform group-hover:scale-125"
          style={enabled ? { background: color } : { boxShadow: `inset 0 0 0 2px ${color}`, background: 'var(--panel)' }}
        />
      </div>

      {/* Mouse convenience: clicking anywhere on the row opens it (keyboard users use the value button). */}
      <div
        onClick={(event) => {
          if (selecting || event.metaKey || event.ctrlKey) onSelect(rule.id, event.shiftKey);
          else onOpen(rule);
        }}
        className={cn(
          'my-0.5 grid min-h-11 cursor-default grid-cols-[18px_26px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-1.5 py-1.5 transition-colors',
          'md:grid-cols-[18px_26px_116px_minmax(0,1fr)_auto_auto]',
          'hover:bg-surface-2/70 focus-within:bg-surface-2/70',
          selected && 'bg-accent-soft/70 hover:bg-accent-soft',
          flash && 'animate-[pulse-flash_1.6s_ease-out]',
          !enabled && 'text-ink-3',
        )}
      >
        <span className="flex items-center justify-center">
          {draggable ? (
            <button
              ref={setActivatorNodeRef}
              type="button"
              aria-label="拖动排序"
              className={cn(
                'flex h-6 w-5 cursor-grab items-center justify-center rounded text-ink-4 opacity-0 transition hover:text-ink-2 group-hover:opacity-100 active:cursor-grabbing',
                selecting && 'hidden',
              )}
              onClick={(event) => event.stopPropagation()}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={14} />
            </button>
          ) : null}
              <span className={cn(draggable && !selecting ? 'hidden' : 'flex', 'items-center')} onClick={(e) => e.stopPropagation()}>
            {(selecting || selected) && (
              <Checkbox checked={selected} onCheckedChange={() => onSelect(rule.id, false)} />
            )}
          </span>
        </span>

        <span className="tnum text-right font-mono text-[11px] text-ink-4">{position ?? '—'}</span>

        <span className="hidden truncate font-mono text-[11px] tracking-tight text-ink-3 md:block" title={meta.label}>
          {rule.type}
        </span>

        <span className="flex min-w-0 items-center gap-2 max-md:col-start-3 max-md:row-start-1">
          <span className="shrink-0 font-mono text-[10.5px] text-ink-3 md:hidden">{rule.type}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (selecting) onSelect(rule.id, event.shiftKey);
              else onOpen(rule);
            }}
            aria-label={`编辑规则 ${rule.type} ${rule.value}`}
            className={cn(
              'min-w-0 truncate rounded text-left font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              enabled ? 'text-ink' : 'text-ink-3 line-through decoration-ink-4',
            )}
          >
            {rule.value}
          </button>
          {rule.options?.map((option) => (
            <span key={option} className="shrink-0 rounded border border-line px-1 font-mono text-[10px] text-ink-3 max-md:hidden">
              {option}
            </span>
          ))}
          {rule.note && <span className="hidden truncate text-xs text-ink-3 lg:inline">· {rule.note}</span>}
        </span>

        <span className="flex items-center gap-2 max-md:col-start-3 max-md:row-start-2 max-md:mt-1 md:justify-end">
          <span className="text-ink-4 md:hidden">→</span>
          <PolicyChip policy={rule.policy} size="sm" muted={!enabled} className={cn(isBuiltinPolicy(rule.policy) && 'font-mono')} />
        </span>

          <span
          className="flex items-center justify-end gap-1 max-md:col-start-4 max-md:row-span-2 max-md:row-start-1"
          onClick={(event) => event.stopPropagation()}
        >
          <Tooltip content={enabled ? '停用' : '启用'}>
            <span className="flex items-center">
              <Switch size="sm" checked={enabled} onCheckedChange={(next) => onToggle(rule, next)} label={enabled ? '停用规则' : '启用规则'} />
            </span>
          </Tooltip>
          <Menu
            trigger={
              <button
                type="button"
                aria-label="更多操作"
                className="flex size-7 items-center justify-center rounded-md text-ink-3 opacity-60 transition hover:bg-surface-3 hover:text-ink group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal size={15} />
              </button>
            }
            items={[
              { label: '编辑', icon: Pencil, onSelect: () => onOpen(rule) },
              { label: selected ? '取消选择' : '选择', icon: SquareCheck, onSelect: () => onSelect(rule.id, false) },
              { label: '复制一条', icon: Copy, onSelect: () => onDuplicate(rule) },
              'separator',
              { label: '上移一位', icon: ArrowUp, onSelect: () => onMove(rule, 'up'), disabled: !canMoveUp },
              { label: '下移一位', icon: ArrowDown, onSelect: () => onMove(rule, 'down'), disabled: !canMoveDown },
              'separator',
              { label: '删除', icon: Trash2, tone: 'danger', onSelect: () => onDelete(rule) },
            ]}
          />
        </span>
      </div>
    </li>
  );
});
