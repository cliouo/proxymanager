import type { HTMLAttributes } from 'react';

export function Kbd({ className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={`inline-flex items-center justify-center min-w-[1.25rem] px-1.5 py-px font-mono text-[11px] leading-[1.5] rounded bg-[var(--color-surface)] text-[var(--color-muted)] border border-[var(--color-border)] ${className}`}
      {...props}
    />
  );
}
