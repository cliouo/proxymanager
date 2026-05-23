import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

// pm-focus-ring 来自 globals.css，双层陶土环（DESIGN.md §Elevation.5）。
const BASE =
  'pm-focus-ring inline-flex items-center justify-center gap-1.5 font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98] tracking-[-0.005em]';

const VARIANTS: Record<Variant, string> = {
  primary:
    'rounded-full bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)] border border-[var(--color-primary)] hover:border-[var(--color-primary-hover)]',
  secondary:
    'rounded-lg bg-[var(--color-surface)] text-[var(--color-fg)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-strong)]',
  danger:
    'rounded-lg bg-transparent text-[var(--color-danger)] border border-[var(--color-danger)]/40 hover:bg-[var(--color-danger)]/8 hover:border-[var(--color-danger)]',
  ghost:
    'rounded-lg bg-transparent text-[var(--color-muted)] border border-transparent hover:bg-[var(--color-bg-sunk)] hover:text-[var(--color-fg)]',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-[13px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
}
