import type { ComponentType, ReactNode, Ref } from 'react';
import { cn } from '@/ui/lib/cn';

/* ─── Badge ──────────────────────────────────────────────────────────── */

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'outline' | 'solid';

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2 border border-line',
  accent: 'bg-accent-soft text-accent border border-accent-line/60',
  ok: 'bg-ok-soft text-ok border border-ok/20',
  warn: 'bg-warn-soft text-warn border border-warn/25',
  bad: 'bg-bad-soft text-bad border border-bad/20',
  outline: 'text-ink-2 border border-line-strong',
  solid: 'bg-inverse text-inverse-ink border border-transparent',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  icon: Icon,
  mono,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-2xs font-medium',
        mono && 'font-mono text-[10.5px] tracking-tight',
        toneClasses[tone],
        className,
      )}
    >
      {Icon && <Icon size={11} strokeWidth={2} />}
      {children}
    </span>
  );
}

/* ─── Status dot ─────────────────────────────────────────────────────── */

const dotTone = {
  ok: 'text-ok bg-ok',
  warn: 'text-warn bg-warn',
  bad: 'text-bad bg-bad',
  idle: 'text-ink-4 bg-ink-4',
  accent: 'text-accent bg-accent',
};

export function StatusDot({
  tone = 'ok',
  pulse,
  className,
  size = 8,
}: {
  tone?: keyof typeof dotTone;
  pulse?: boolean;
  className?: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn('inline-block shrink-0 rounded-full', dotTone[tone], pulse && 'motion-safe:animate-pulse-ring', className)}
    />
  );
}

/* ─── Kbd ────────────────────────────────────────────────────────────── */

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line bg-surface px-1 font-mono text-[10.5px] font-medium text-ink-3 shadow-[0_1px_0_var(--line)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/* ─── Card ───────────────────────────────────────────────────────────── */

export function Card({
  children,
  className,
  as: As = 'section',
  interactive,
  ref,
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'li';
  interactive?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <As
      ref={ref as Ref<never>}
      className={cn(
        'rounded-xl border border-line bg-surface shadow-xs',
        interactive && 'transition-[border-color,box-shadow,transform] duration-200 hover:border-line-strong hover:shadow-md',
        className,
      )}
    >
      {children}
    </As>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon: Icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  className?: string;
}) {
  return (
    <header className={cn('flex items-start justify-between gap-3 px-4 pb-3 pt-3.5', className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-2">
            <Icon size={14} strokeWidth={1.75} />
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-ink">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

/* ─── Skeleton ───────────────────────────────────────────────────────── */

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={cn('skeleton h-4', className)} style={style} />;
}

/* ─── Empty state ────────────────────────────────────────────────────── */

export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  className,
  compact,
}: {
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-6 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      {Icon && (
        <div className="relative mb-1">
          <svg width="88" height="56" viewBox="0 0 88 56" className="text-line-strong" aria-hidden>
            <path d="M4 40 C24 40 28 16 44 16 S64 40 84 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 4" />
          </svg>
          <span className="absolute left-1/2 top-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl border border-line bg-surface text-ink-2 shadow-sm">
            <Icon size={18} strokeWidth={1.6} />
          </span>
        </div>
      )}
      <div className="max-w-sm">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && <p className="mt-1 text-xs leading-relaxed text-ink-3">{description}</p>}
      </div>
      {actions && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}

/* ─── Monogram avatar ────────────────────────────────────────────────── */

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function Monogram({
  name,
  size = 32,
  className,
  colorKey,
}: {
  name: string;
  size?: number;
  className?: string;
  colorKey?: string;
}) {
  const hue = hashString(colorKey ?? name) % 360;
  const glyph = Array.from(name.replace(/^[^\p{L}\p{N}]+/u, '') || name)[0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(140deg, oklch(0.72 0.12 ${hue}) 0%, oklch(0.56 0.15 ${(hue + 40) % 360}) 100%)`,
      }}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-[28%] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.12)]',
        className,
      )}
    >
      {glyph}
    </span>
  );
}

/* ─── Serif numeral stat ─────────────────────────────────────────────── */

export function Numeral({
  value,
  className,
  suffix,
}: {
  value: ReactNode;
  className?: string;
  suffix?: ReactNode;
}) {
  return (
    <span className={cn('tnum font-display leading-none tracking-tight text-ink', className)}>
      {value}
      {suffix && <span className="ml-1 font-sans text-sm font-normal tracking-normal text-ink-3">{suffix}</span>}
    </span>
  );
}

/* ─── Inline code ────────────────────────────────────────────────────── */

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'rounded-[5px] border border-line bg-surface-2 px-1 py-px font-mono text-[11.5px] text-ink-2',
        className,
      )}
    >
      {children}
    </code>
  );
}

/* ─── Section heading ────────────────────────────────────────────────── */

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3', className)}>{children}</div>
  );
}

export function Divider({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div aria-hidden className={cn(vertical ? 'w-px self-stretch bg-line' : 'h-px w-full bg-line', className)} />;
}
