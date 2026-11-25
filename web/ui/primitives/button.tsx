'use client';

import { forwardRef, isValidElement, type ComponentType, type ReactNode } from 'react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { cn } from '@/ui/lib/cn';
import { Spinner } from './spinner';

type IconLike = ComponentType<{ className?: string; size?: number; strokeWidth?: number }> | ReactNode;

export type ButtonVariant =
  | 'primary'
  | 'accent'
  | 'secondary'
  | 'ghost'
  | 'subtle'
  | 'danger'
  | 'danger-ghost'
  | 'link';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-inverse text-inverse-ink shadow-xs hover:bg-inverse/88 active:bg-inverse/80 disabled:bg-inverse/40',
  accent:
    'bg-accent text-accent-ink shadow-xs hover:bg-accent-hover disabled:opacity-50',
  secondary:
    'bg-surface text-ink border border-line shadow-xs hover:border-line-strong hover:bg-surface-2 disabled:text-ink-4',
  ghost:
    'text-ink-2 hover:bg-surface-2 hover:text-ink data-open:bg-surface-2 data-[state=open]:bg-surface-2 disabled:text-ink-4',
  subtle: 'bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink disabled:text-ink-4',
  danger: 'bg-bad text-white shadow-xs hover:bg-bad/90 disabled:opacity-50',
  'danger-ghost': 'text-bad hover:bg-bad-soft disabled:opacity-50',
  link: 'text-accent hover:underline underline-offset-4 !h-auto !px-0 disabled:opacity-50',
};

const sizes: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded-sm',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-1.5 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

const iconOnlySizes: Record<ButtonSize, string> = {
  xs: 'w-6 px-0',
  sm: 'w-7 px-0',
  md: 'w-8 px-0',
  lg: 'w-10 px-0',
};

const iconSize: Record<ButtonSize, number> = { xs: 13, sm: 14, md: 15, lg: 16 };

function renderIcon(icon: IconLike | undefined, size: ButtonSize) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in icon)) {
    const Icon = icon as ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
    return <Icon size={iconSize[size]} strokeWidth={1.75} className="shrink-0" />;
  }
  return icon as ReactNode;
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconLike;
  trailingIcon?: IconLike;
  loading?: boolean;
  iconOnly?: boolean;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    trailingIcon,
    loading = false,
    iconOnly = false,
    asChild = false,
    className,
    children,
    disabled,
    type,
    onClick,
    ...props
  },
  ref,
) {
  const handleClick = onClick
    ? (event: React.MouseEvent<HTMLElement>) => {
        // Callers control pending UI via `loading` and often await confirmAction() inside onClick;
        // returning that Promise would stall ui-sdk Button's agent press until the dialog closes.
        void onClick(event as React.MouseEvent<HTMLButtonElement>);
      }
    : undefined;
  const classes = cn(
    'relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
    'transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150',
    'active:translate-y-px disabled:pointer-events-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    variants[variant],
    sizes[size],
    iconOnly && iconOnlySizes[size],
    className,
  );

  if (asChild && isValidElement<{ children?: ReactNode }>(children)) {
    return (
      <UiButton
        ref={ref}
        render={children}
        className={classes}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        onClick={handleClick}
        {...props}
      >
        {children.props.children}
      </UiButton>
    );
  }

  return (
    <UiButton
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={handleClick}
      {...props}
    >
      {loading ? <Spinner size={iconSize[size]} /> : renderIcon(icon, size)}
      {children}
      {!loading && renderIcon(trailingIcon, size)}
    </UiButton>
  );
});
