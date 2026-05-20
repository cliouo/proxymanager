import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--color-accent)] text-[var(--color-bg)] hover:bg-[var(--color-accent-strong)]',
  secondary:
    'bg-[var(--color-surface-2)] text-[var(--color-fg)] border border-[var(--color-border)] hover:bg-[var(--color-border)]',
  danger:
    'bg-transparent text-[var(--color-danger)] border border-[var(--color-danger)] hover:bg-[var(--color-danger)]/10',
  ghost: 'bg-transparent text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button className={`${BUTTON_BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`} {...props} />
  );
}

const INPUT_BASE =
  'w-full rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] placeholder-[var(--color-muted)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]/40 disabled:opacity-50';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${INPUT_BASE} h-9 ${className}`} {...props} />;
}

export function Textarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={`${INPUT_BASE} font-[var(--font-mono)] leading-relaxed ${className}`} {...props} />
  );
}

export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${INPUT_BASE} h-9 ${className}`} {...props}>
      {children}
    </select>
  );
}

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}
      {...props}
    />
  );
}

export function CardHeader({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] ${className}`}
      {...props}
    />
  );
}

export function CardTitle({ className = '', ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={`text-sm font-semibold ${className}`} {...props} />;
}

export function CardBody({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 ${className}`} {...props} />;
}

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

export function Badge({
  tone = 'neutral',
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}

export function Label({ className = '', ...props }: HTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={`block text-xs text-[var(--color-muted)] mb-1 ${className}`}
      {...props}
    />
  );
}
