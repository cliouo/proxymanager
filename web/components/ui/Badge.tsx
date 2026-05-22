import type { HTMLAttributes } from 'react';

type Tone = 'neutral' | 'accent' | 'warn' | 'danger' | 'success';

const TONES: Record<Tone, string> = {
  neutral:
    'bg-[var(--color-bg-sunk)] text-[var(--color-fg-soft)] border border-[var(--color-border)]',
  accent:
    'bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)] border border-[var(--color-primary)]/20',
  warn: 'bg-[#F5E5C9] text-[var(--color-warn)] border border-[var(--color-warn)]/30',
  danger:
    'bg-[#F4D8D2] text-[var(--color-danger)] border border-[var(--color-danger)]/30',
  success:
    'bg-[#E6EEDD] text-[var(--color-success)] border border-[var(--color-success)]/30',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = 'neutral', className = '', ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium leading-[1.3] tracking-[0.005em] whitespace-nowrap ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}
