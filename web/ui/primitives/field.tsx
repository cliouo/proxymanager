'use client';

import { createContext, forwardRef, useContext, useId, type ReactNode } from 'react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { Field as UiField, FieldDescription, FieldLabel } from '@ui-sdk/react/field';
import { Input as UiInput } from '@ui-sdk/react/input';
import { Textarea as UiTextarea } from '@ui-sdk/react/textarea';
import { Search, X } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

const fieldBase = cn(
  'w-full rounded-md border border-line bg-surface text-sm text-ink shadow-xs',
  'placeholder:text-ink-4 transition-[border-color,box-shadow] duration-150',
  'hover:border-line-strong focus:border-accent focus:shadow-[var(--ring)] focus:outline-none',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3',
  'aria-[invalid=true]:border-bad aria-[invalid=true]:focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--bad)_18%,transparent)]',
);

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

function toStringValue(value: string | number | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : String(value);
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
  inputSize?: 'sm' | 'md' | 'lg';
  onValueChange?: (value: string) => void;
}

const inputSizes = { sm: 'h-7 text-xs', md: 'h-8', lg: 'h-10 text-base' };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    mono,
    leading,
    trailing,
    invalid,
    className,
    inputSize = 'md',
    value,
    defaultValue,
    onValueChange,
    onChange,
    ...props
  },
  ref,
) {
  const a11y = useFieldA11y(props.id, invalid, props.required, props['aria-describedby']);
  const handleValueChange =
    onValueChange || onChange
      ? (next: string, details: { source?: string }) => {
          onValueChange?.(next);
          if (details.source === 'agent' && !onValueChange && onChange) {
            onChange({
              target: { value: next },
              currentTarget: { value: next },
            } as React.ChangeEvent<HTMLInputElement>);
          }
        }
      : undefined;

  if (leading || trailing) {
    return (
      <div className={cn('relative flex items-center', className)}>
        {leading && (
          <span className="pointer-events-none absolute left-2.5 flex items-center text-ink-3">
            {leading}
          </span>
        )}
        <UiInput
          ref={ref}
          value={toStringValue(value)}
          defaultValue={toStringValue(defaultValue)}
          onChange={onChange}
          onValueChange={handleValueChange}
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
    <UiInput
      ref={ref}
      value={toStringValue(value)}
      defaultValue={toStringValue(defaultValue)}
      onChange={onChange}
      onValueChange={handleValueChange}
      className={cn(fieldBase, inputSizes[inputSize], 'px-2.5', mono && 'font-mono text-[12.5px]', className)}
      {...props}
      {...a11y}
    />
  );
});

export interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSubmit'> {
  mono?: boolean;
  invalid?: boolean;
  onValueChange?: (value: string) => void;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, invalid, className, value, defaultValue, onValueChange, onChange, ...props },
  ref,
) {
  const a11y = useFieldA11y(props.id, invalid, props.required, props['aria-describedby']);
  const handleValueChange =
    onValueChange || onChange
      ? (next: string, details: { source?: string }) => {
          onValueChange?.(next);
          if (details.source === 'agent' && !onValueChange && onChange) {
            onChange({
              target: { value: next },
              currentTarget: { value: next },
            } as React.ChangeEvent<HTMLTextAreaElement>);
          }
        }
      : undefined;

  return (
    <UiTextarea
      ref={ref}
      value={toStringValue(value)}
      defaultValue={toStringValue(defaultValue)}
      onChange={onChange}
      onValueChange={handleValueChange}
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
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  shortcut?: ReactNode;
  inputSize?: 'sm' | 'md' | 'lg';
  'aria-label'?: string;
}) {
  return (
    <Input
      className={className}
      inputSize={inputSize}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      onValueChange={(next) => onChange(next)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && value) {
          event.stopPropagation();
          onChange('');
        }
      }}
      leading={<Search size={14} strokeWidth={1.75} />}
      trailing={
        value ? (
          <UiButton
            type="button"
            aria-label="清除搜索"
            onClick={() => onChange('')}
            className="flex size-5 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <X size={12} />
          </UiButton>
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
  inline?: boolean;
  children: (id: string) => ReactNode;
}

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
        <UiField
          invalid={Boolean(error) || undefined}
          className={cn('flex items-start justify-between gap-6 py-3', className)}
        >
          <div className="min-w-0 flex-1 pt-1">
            {label && (
              <FieldLabel
                htmlFor={id}
                className="flex items-center gap-1.5 text-sm font-medium text-ink"
              >
                {label}
                {optional && <span className="font-normal text-ink-4">可选</span>}
              </FieldLabel>
            )}
            {hint && !error && (
              <FieldDescription id={hintId} className="mt-0.5 text-xs text-ink-3">
                {hint}
              </FieldDescription>
            )}
            {error && (
              <p id={errorId} className="mt-0.5 text-xs text-bad">
                {error}
              </p>
            )}
          </div>
          <div className="shrink-0">{children(id)}</div>
        </UiField>
      </FieldContext.Provider>
    );
  }
  return (
    <FieldContext.Provider value={a11y}>
      <UiField
        invalid={Boolean(error) || undefined}
        className={cn('flex flex-col gap-1.5', className)}
      >
        {label && (
          <FieldLabel
            htmlFor={id}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-2"
          >
            {label}
            {optional && <span className="font-normal text-ink-4">可选</span>}
          </FieldLabel>
        )}
        {children(id)}
        {error ? (
          <p id={errorId} className="text-xs text-bad">
            {error}
          </p>
        ) : hint ? (
          <FieldDescription id={hintId} className="text-xs leading-relaxed text-ink-3">
            {hint}
          </FieldDescription>
        ) : null}
      </UiField>
    </FieldContext.Provider>
  );
}
