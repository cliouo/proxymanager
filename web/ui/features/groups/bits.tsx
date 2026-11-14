'use client';

import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/ui/lib/cn';
import { Flag, describeNode } from '@/ui/viz/nodes';
import { highlightRanges } from './model';

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

const noteTones = {
  info: 'border-line bg-surface-2/70 [&_svg.note-icon]:text-ink-3',
  accent: 'border-accent-line/70 bg-accent-soft/60 [&_svg.note-icon]:text-accent',
  warn: 'border-warn/25 bg-warn-soft/70 [&_svg.note-icon]:text-warn',
  bad: 'border-bad/25 bg-bad-soft/70 [&_svg.note-icon]:text-bad',
};

/** Inline callout used inside the editor and overview. */
export function Note({
  tone = 'info',
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof noteTones;
  icon?: IconType;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5', noteTones[tone], className)}>
      {Icon && <Icon size={15} strokeWidth={1.75} className="note-icon mt-px shrink-0" />}
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-ink-2">
        {title && <div className="text-[13px] font-medium text-ink">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

/** A titled card section of the editor. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn('rounded-xl border border-line bg-surface shadow-xs', className)}>
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** A node chip; the part of its name a filter matched is highlighted so substring surprises are visible. */
export function NodeChip({ name, filter, muted }: { name: string; filter?: string; muted?: boolean }) {
  const info = describeNode(name);
  const ranges = filter ? merge(highlightRanges(info.label, filter)) : [];
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(info.label.slice(cursor, start));
    parts.push(
      <mark key={index} className="rounded-[3px] bg-accent-soft px-px text-accent">
        {info.label.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < info.label.length) parts.push(info.label.slice(cursor));
  return (
    <span
      title={name}
      className={cn(
        'inline-flex h-6 max-w-[240px] items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-xs text-ink-2',
        muted && 'border-dashed bg-transparent text-ink-4',
      )}
    >
      <Flag region={info.region} size={12} />
      <span className="truncate">{parts}</span>
    </span>
  );
}
