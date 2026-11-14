'use client';

import { createContext, forwardRef, useContext, useId, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

const fieldBase = cn(
  'w-full rounded-md border border-line bg-surface text-sm text-ink shadow-xs',
  'placeholder:text-ink-4 transition-[border-color,box-shadow] duration-150',
  'hover:border-line-strong focus:border-accent focus:shadow-[var(--ring)] focus:outline-none',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3',
  'aria-[invalid=true]:border-bad aria-[invalid=true]:focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--bad)_18%,transparent)]',
);

/**
 * Set by <Field>: the control whose id matches gets aria-describedby pointing
 * at the hint or (only while shown) the error, and aria-invalid while there
 * is an error — so screen readers read the message when the field is focused.
 */
interface FieldA11y {
  id: string;
  describedBy?: string;
  invalid: boolean;
}
const FieldContext = createContext<FieldA11y | null>(null);

function useFieldA11y(
  id: string | undefined,
  invalid: boolean | undefined,
  required: boolean | undefined,
  describedBy: string | undefined,
) {
  const field = useContext(FieldContext);
  const own = field && id === field.id ? field : null;
  const isInvalid = !!invalid || !!own?.invalid;
  return {
    // "false" (not unset) on required fields: Firefox/Safari otherwise report an
    // untouched empty required field as invalid.
    'aria-invalid': isInvalid ? true : required ? false : undefined,
    'aria-describedby': [describedBy, own?.describedBy].filter(Boolean).join(' ') || undefined,
  };
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
  inputSize?: 'sm' | 'md' | 'lg';
}

const inputSizes = { sm: 'h-7 text-xs', md: 'h-8', lg: 'h-10 text-base' };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, leading, trailing, invalid, className, inputSize = 'md', ...props },
  ref,
) {
  const a11y = useFieldA11y(props.id, invalid, props.required, props['aria-describedby']);
  if (leading || trailing) {
    return (
      <div className={cn('relative flex items-center', className)}>
        {leading && (
          <span className="pointer-events-none absolute left-2.5 flex items-center text-ink-3">
            {leading}
          </span>
        )}
        <input
          ref={ref}
          className={cn(
            fieldBase,
            inputSizes[inputSize],
            'px-2.5',
            leading && 'pl-8',
            trailing && 'pr-8',
            mono && 'font-mono text-[12.5px]',
          )}
          {...props}
          {...a11y}
        />
        {trailing && <span className="absolute right-1.5 flex items-center">{trailing}</span>}
      </div>
    );
  }
  return (
    <input
      ref={ref}
      className={cn(fieldBase, inputSizes[inputSize], 'px-2.5', mono && 'font-mono text-[12.5px]', className)}
      {...props}
      {...a11y}
    />
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, invalid, className, ...props },
  ref,
) {
  const a11y = useFieldA11y(props.id, invalid, props.required, props['aria-describedby']);
  return (
    <textarea
      ref={ref}
      className={cn(
        fieldBase,
        'min-h-[84px] resize-y px-2.5 py-2 leading-relaxed',
        mono && 'font-mono text-[12.5px]',
        className,
      )}
      {...props}
      {...a11y}
    />
  );
});

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  className,
  autoFocus,
  shortcut,
  inputSize = 'md',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  shortcut?: ReactNode;
  inputSize?: 'sm' | 'md' | 'lg';
}) {
  return (
    <Input
      className={className}
      inputSize={inputSize}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && value) {
          event.stopPropagation();
          onChange('');
        }
      }}
      leading={<Search size={14} strokeWidth={1.75} />}
      trailing={
        value ? (
          <button
            type="button"
            aria-label="清除"
            onClick={() => onChange('')}
            className="flex size-5 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <X size={12} />
          </button>
        ) : (
          shortcut
        )
      }
    />
  );
}

export function Label({
  children,
  htmlFor,
  className,
  optional,
}: {
  children: ReactNode;
  htmlFor?: string;
  className?: string;
  optional?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className={cn('flex items-center gap-1.5 text-xs font-medium text-ink-2', className)}>
      {children}
      {optional && <span className="font-normal text-ink-4">可选</span>}
    </label>
  );
}

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
  /** Render label and control side by side (settings rows). */
  inline?: boolean;
  children: (id: string) => ReactNode;
}

/** Label + control + hint/error, wired with a shared id (and aria-describedby, see FieldContext). */
export function Field({ label, hint, error, optional, className, inline, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const a11y: FieldA11y = {
    id,
    invalid: !!error,
    describedBy: error ? errorId : hint ? hintId : undefined,
  };
  if (inline) {
    return (
      <FieldContext.Provider value={a11y}>
        <div className={cn('flex items-start justify-between gap-6 py-3', className)}>
          <div className="min-w-0 flex-1 pt-1">
            {label && (
              <Label htmlFor={id} optional={optional} className="text-sm font-medium text-ink">
                {label}
              </Label>
            )}
            {hint && !error && (
              <p id={hintId} className="mt-0.5 text-xs text-ink-3">
                {hint}
              </p>
            )}
            {error && (
              <p id={errorId} className="mt-0.5 text-xs text-bad">
                {error}
              </p>
            )}
          </div>
          <div className="shrink-0">{children(id)}</div>
        </div>
      </FieldContext.Provider>
    );
  }
  return (
    <FieldContext.Provider value={a11y}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        {label && (
          <Label htmlFor={id} optional={optional}>
            {label}
          </Label>
        )}
        {children(id)}
        {error ? (
          <p id={errorId} className="text-xs text-bad">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs leading-relaxed text-ink-3">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
