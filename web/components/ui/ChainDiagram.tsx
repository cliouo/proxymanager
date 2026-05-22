import type { ReactNode } from 'react';

interface ChainNodeProps {
  label: string;
  tone?: 'front' | 'chain' | 'backend' | 'pool';
}

const TONES = {
  front: 'bg-[var(--color-surface)] text-[var(--color-fg)] border-[var(--color-border-strong)]',
  chain: 'bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)] border-[var(--color-primary)]/30',
  backend: 'bg-[var(--color-bg-strong)] text-[var(--color-fg)] border-[var(--color-border-strong)]',
  pool: 'bg-[var(--color-surface)] text-[var(--color-fg-soft)] border-[var(--color-border)]',
} as const;

export function ChainNode({ label, tone = 'front' }: ChainNodeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 h-7 rounded-md border font-mono text-[12px] whitespace-nowrap ${TONES[tone]}`}
    >
      {label}
    </span>
  );
}

export function ChainArrow() {
  return (
    <span
      className="inline-flex items-center text-[var(--color-muted)] font-mono select-none"
      aria-hidden
    >
      ─→
    </span>
  );
}

interface ChainPoolProps {
  name: string;
  members: string[];
}

/** 链路池：N 个前置候选 + 池名 */
export function ChainPool({ name, members }: ChainPoolProps) {
  return (
    <div className="inline-flex flex-col gap-1.5 p-2 rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-sunk)]">
      <span className="text-[10px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] font-mono">
        {name}
      </span>
      <div className="flex flex-wrap gap-1">
        {members.length === 0 ? (
          <span className="text-[12px] italic text-[var(--color-muted)]">（空）</span>
        ) : (
          members.map((m) => <ChainNode key={m} label={m} tone="pool" />)
        )}
      </div>
    </div>
  );
}

interface ChainRowProps {
  children: ReactNode;
  actions?: ReactNode;
}

/** 链路行：node → arrow → node →… + 右侧 actions */
export function ChainRow({ children, actions }: ChainRowProps) {
  return (
    <div className="flex items-start gap-3 py-3 px-4 border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg-sunk)] transition-colors">
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}
