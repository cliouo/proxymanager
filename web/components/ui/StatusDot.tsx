import type { HTMLAttributes } from 'react';

type Tone = 'on' | 'warn' | 'off' | 'error';

const TONES: Record<Tone, string> = {
  on: 'bg-[var(--color-dot-on)]',
  warn: 'bg-[var(--color-dot-warn)]',
  off: 'bg-[var(--color-dot-off)]',
  error: 'bg-[var(--color-dot-error)]',
};

interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** 给 sr-only 屏阅读器的语义文本（如「启用」「已禁用」）。 */
  label?: string;
}

/**
 * 6px 圆形状态点 — 替代 enabled/disabled badge 的精简形态。
 * 静默存在，不加 ring / glow / 动画。
 */
export function StatusDot({
  tone = 'off',
  label,
  className = '',
  ...props
}: StatusDotProps) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${TONES[tone]} ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      {...props}
    />
  );
}
