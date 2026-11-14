'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react';
import { cn } from '@/ui/lib/cn';
import { Popover } from './overlay';

export interface ComboOption {
  value: string;
  label?: ReactNode;
  /** Extra text matched by search (aliases, descriptions). */
  keywords?: string[];
  group?: string;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

function groupOptions(options: ComboOption[]) {
  const groups = new Map<string, ComboOption[]>();
  for (const option of options) {
    const key = option.group ?? '';
    const list = groups.get(key) ?? [];
    list.push(option);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

const listGroupClass =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3';

const triggerClass = cn(
  'inline-flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm text-ink shadow-xs',
  'transition-[border-color,box-shadow] hover:border-line-strong focus-visible:border-accent focus-visible:shadow-[var(--ring)] focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3 data-[state=open]:border-accent data-[state=open]:shadow-[var(--ring)]',
);

export interface ComboboxProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Offer "use '<query>'" when nothing matches exactly. */
  allowCustom?: boolean;
  customLabel?: (query: string) => ReactNode;
  renderValue?: (value: string, option?: ComboOption) => ReactNode;
  className?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  invalid?: boolean;
  align?: 'start' | 'center' | 'end';
  width?: number;
  id?: string;
  /** Replace the default trigger entirely. */
  trigger?: ReactNode;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder = '请选择',
  searchPlaceholder = '搜索…',
  emptyText = '没有匹配项',
  allowCustom,
  customLabel,
  renderValue,
  className,
  size = 'md',
  disabled,
  invalid,
  align = 'start',
  width,
  id,
  trigger,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((o) => o.value === value);
  const grouped = useMemo(() => groupOptions(options), [options]);
  const trimmed = query.trim();
  const showCustom = allowCustom && trimmed && !options.some((o) => o.value === trimmed);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      align={align}
      className="p-0"
      trigger={
        trigger ?? (
          <button
            id={id}
            type="button"
            disabled={disabled}
            data-invalid={invalid || undefined}
            className={cn(triggerClass, size === 'sm' ? 'h-7 text-xs' : 'h-8', invalid && 'border-bad', className)}
          >
            <span className={cn('min-w-0 flex-1 truncate', !value && 'text-ink-4')}>
              {value ? (renderValue ? renderValue(value, selected) : (selected?.label ?? value)) : placeholder}
            </span>
            <ChevronsUpDown size={13} className="shrink-0 text-ink-3" />
          </button>
        )
      }
    >
      <Command loop className="flex flex-col" style={{ width: width ?? 'max(var(--radix-popover-trigger-width), 240px)' }}>
        <div className="border-b border-line p-1.5">
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
            className="h-8 w-full bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-4"
          />
        </div>
        <Command.List className="max-h-[300px] overflow-y-auto p-1">
          {!showCustom && <Command.Empty className="px-2 py-6 text-center text-xs text-ink-3">{emptyText}</Command.Empty>}
          {showCustom && (
            <Command.Item
              value={`__custom__ ${trimmed}`}
              onSelect={() => pick(trimmed)}
              className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-ink data-[selected=true]:bg-surface-2"
            >
              <Plus size={14} className="text-ink-3" />
              {customLabel ? customLabel(trimmed) : <>使用「{trimmed}」</>}
            </Command.Item>
          )}
          {grouped.map(([group, items]) => (
            <Command.Group key={group || 'default'} heading={group || undefined} className={listGroupClass}>
              {items.map((option) => (
                <Command.Item
                  key={option.value}
                  value={option.value}
                  keywords={[typeof option.label === 'string' ? option.label : '', ...(option.keywords ?? [])]}
                  disabled={option.disabled}
                  onSelect={() => pick(option.value)}
                  className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm text-ink data-[disabled=true]:text-ink-4 data-[selected=true]:bg-surface-2"
                >
                  {option.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label ?? option.value}</span>
                    {option.description && <span className="block truncate text-[11px] text-ink-3">{option.description}</span>}
                  </span>
                  {option.value === value && <Check size={14} className="shrink-0 text-accent" />}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </Popover>
  );
}

export interface MultiComboboxProps {
  value: string[];
  onChange: (value: string[]) => void;
  options: ComboOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allowCustom?: boolean;
  renderChip?: (value: string, option?: ComboOption) => ReactNode;
  className?: string;
  disabled?: boolean;
  width?: number;
  trigger?: ReactNode;
  align?: 'start' | 'center' | 'end';
}

/** Multi-select with search; selected values render as removable chips. */
export function MultiCombobox({
  value,
  onChange,
  options,
  placeholder = '添加…',
  searchPlaceholder = '搜索…',
  emptyText = '没有匹配项',
  allowCustom,
  renderChip,
  className,
  disabled,
  width,
  trigger,
  align = 'start',
}: MultiComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const grouped = useMemo(() => groupOptions(options), [options]);
  const selected = new Set(value);
  const trimmed = query.trim();
  const showCustom = allowCustom && trimmed && !options.some((o) => o.value === trimmed) && !selected.has(trimmed);

  const toggle = (next: string) => {
    onChange(selected.has(next) ? value.filter((v) => v !== next) : [...value, next]);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {value.map((item) => {
        const option = options.find((o) => o.value === item);
        return (
          <span key={item} className="group inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2 pr-1 text-xs text-ink shadow-xs">
            <span className="min-w-0 truncate">{renderChip ? renderChip(item, option) : (option?.label ?? item)}</span>
            {!disabled && (
              <button
                type="button"
                aria-label={`移除 ${item}`}
                onClick={() => toggle(item)}
                className="flex size-4 items-center justify-center rounded-full text-ink-4 hover:bg-surface-3 hover:text-ink"
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            )}
          </span>
        );
      })}
      {!disabled && (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery('');
          }}
          align={align}
          className="p-0"
          trigger={
            trigger ?? (
              <button
                type="button"
                className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-xs text-ink-3 transition hover:border-ink-3 hover:text-ink"
              >
                <Plus size={12} />
                {placeholder}
              </button>
            )
          }
        >
          <Command loop className="flex flex-col" style={{ width: width ?? 280 }}>
            <div className="border-b border-line p-1.5">
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={searchPlaceholder}
                className="h-8 w-full bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-4"
              />
            </div>
            <Command.List className="max-h-[300px] overflow-y-auto p-1">
              {!showCustom && <Command.Empty className="px-2 py-6 text-center text-xs text-ink-3">{emptyText}</Command.Empty>}
              {showCustom && (
                <Command.Item
                  value={`__custom__ ${trimmed}`}
                  onSelect={() => {
                    toggle(trimmed);
                    setQuery('');
                  }}
                  className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-ink data-[selected=true]:bg-surface-2"
                >
                  <Plus size={14} className="text-ink-3" />
                  添加「{trimmed}」
                </Command.Item>
              )}
              {grouped.map(([group, items]) => (
                <Command.Group key={group || 'default'} heading={group || undefined} className={listGroupClass}>
                  {items.map((option) => {
                    const checked = selected.has(option.value);
                    return (
                      <Command.Item
                        key={option.value}
                        value={option.value}
                        keywords={[typeof option.label === 'string' ? option.label : '', ...(option.keywords ?? [])]}
                        disabled={option.disabled}
                        onSelect={() => toggle(option.value)}
                        className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm text-ink data-[disabled=true]:text-ink-4 data-[selected=true]:bg-surface-2"
                      >
                        <span
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded-[5px] border',
                            checked ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-surface',
                          )}
                        >
                          {checked && <Check size={11} strokeWidth={3} />}
                        </span>
                        {option.icon}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{option.label ?? option.value}</span>
                          {option.description && <span className="block truncate text-[11px] text-ink-3">{option.description}</span>}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Popover>
      )}
    </div>
  );
}

/** Free-text chips (tags, CIDRs, regex fragments). Enter or comma adds. */
export function TagInput({
  value,
  onChange,
  placeholder = '输入后回车添加',
  validate,
  mono,
  className,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Return an error message to reject a value. */
  validate?: (value: string) => string | null;
  mono?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    const next = draft.trim();
    if (!next) return;
    if (value.includes(next)) {
      setError('已存在');
      return;
    }
    const problem = validate?.(next) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    onChange([...value, next]);
    setDraft('');
    setError(null);
  };
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div
        className={cn(
          'flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-1 shadow-xs transition-[border-color,box-shadow]',
          'focus-within:border-accent focus-within:shadow-[var(--ring)]',
          error && 'border-bad',
          disabled && 'bg-surface-2',
        )}
      >
        {value.map((item) => (
          <span
            key={item}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 py-px pl-1.5 pr-0.5 text-xs text-ink',
              mono && 'font-mono text-[11.5px]',
            )}
          >
            <span className="truncate">{item}</span>
            {!disabled && (
              <button
                type="button"
                aria-label={`移除 ${item}`}
                onClick={() => onChange(value.filter((v) => v !== item))}
                className="flex size-4 items-center justify-center rounded text-ink-4 hover:bg-surface-3 hover:text-ink"
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            )}
          </span>
        ))}
        <input
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            // Enter/comma that confirms an IME candidate must not commit a half-typed tag
            // (keyCode 229 covers Safari, which clears isComposing before this keydown).
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={value.length ? '' : placeholder}
          className={cn('h-6 min-w-[120px] flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-4', mono && 'font-mono text-[12.5px]')}
        />
      </div>
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}
