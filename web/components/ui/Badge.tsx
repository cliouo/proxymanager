import type { HTMLAttributes } from 'react';

type Tone = 'neutral' | 'accent' | 'warn' | 'danger';

const TONES: Record<Tone, string> = {
  neutral:
    'bg-[var(--color-surface-2)] text-[var(--color-muted)] border border-[var(--color-border)]',
  accent:
    'bg-[var(--color-accent)]/15 text-[var(--color-accent)] border border-[var(--color-accent)]/30',
  warn: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)] border border-[var(--color-warn)]/30',
  danger:
    'bg-[var(--color-danger)]/15 text-[var(--color-danger)] border border-[var(--color-danger)]/30',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = 'neutral', className = '', ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}
