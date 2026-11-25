'use client';

import { isValidElement, useMemo, useState, type ReactNode } from 'react';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  Combobox as UiCombobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
} from '@ui-sdk/react/combobox';
import { Input as UiInput } from '@ui-sdk/react/input';
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

export interface ComboOption {
  value: string;
  label?: ReactNode;
  keywords?: string[];
  group?: string;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

function optionText(option: ComboOption): string {
  return typeof option.label === 'string' && option.label ? option.label : option.value;
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

const triggerClass = cn(
  'inline-flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm text-ink shadow-xs',
  'transition-[border-color,box-shadow] hover:border-line-strong focus-visible:border-accent focus-visible:shadow-[var(--ring)] focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3 data-open:border-accent data-open:shadow-[var(--ring)]',
);

export interface ComboboxProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
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
  trigger?: ReactNode;
  label?: string;
  'aria-label'?: string;
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
  label,
  'aria-label': ariaLabel,
}: ComboboxProps) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const selected = options.find((o) => o.value === value);
  const grouped = useMemo(() => groupOptions(options), [options]);
  const trimmed = query.trim();
  const showCustom = Boolean(allowCustom && trimmed && !options.some((o) => o.value === trimmed));

  const dataItems = useMemo(
    () =>
      options.map((o) => ({
        value: o.value,
        label: optionText(o),
        keywords: o.keywords,
        disabled: o.disabled,
      })),
    [options],
  );

  return (
    <UiCombobox
      items={dataItems}
      value={value ?? null}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      itemToLabel={(v) => {
        const match = options.find((o) => o.value === v);
        return match ? optionText(match) : v;
      }}
      allowCustomValue={allowCustom}
      disabled={disabled}
      loop
      query={query}
      onQueryChange={(next) => setQuery(next)}
      onOpenChange={(next) => {
        if (next) setQuery('');
      }}
      onOpenChangeComplete={(next) => {
        if (!next) button?.focus();
      }}
    >
      {trigger && isValidElement<{ children?: ReactNode }>(trigger) ? (
        <ComboboxTrigger ref={setButton} render={trigger} disabled={disabled}>
          {trigger.props.children}
        </ComboboxTrigger>
      ) : (
        <ComboboxTrigger
          id={id}
          ref={setButton}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          data-invalid={invalid || undefined}
          className={cn(triggerClass, size === 'sm' ? 'h-7 text-xs' : 'h-8', invalid && 'border-bad', className)}
        >
          <span className={cn('min-w-0 flex-1 truncate', !value && 'text-ink-4')}>
            {value ? (renderValue ? renderValue(value, selected) : (selected?.label ?? value)) : placeholder}
          </span>
          <ChevronsUpDown size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
        </ComboboxTrigger>
      )}
      <ComboboxContent
        anchor={button}
        align={align}
        sideOffset={6}
        collisionPadding={12}
        style={{ width: width ?? 'max(var(--anchor-width), 240px)' }}
        className={cn(
          'z-50 m-0 flex max-h-[var(--available-height)] flex-col overflow-hidden rounded-xl border border-line bg-surface p-0 text-ink shadow-lg outline-none',
          'origin-[var(--transform-origin)] data-ending-style:animate-[sink_0.12s_ease-in_both] data-open:animate-pop',
        )}
      >
        <div className="border-b border-line p-1.5">
          <ComboboxInput
            autoFocus
            aria-label={ariaLabel ?? label ?? searchPlaceholder}
            placeholder={searchPlaceholder}
            className="h-8 w-full bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-4"
          />
        </div>
        {!showCustom && (
          <ComboboxEmpty className="px-2 py-6 text-center text-xs text-ink-3">{emptyText}</ComboboxEmpty>
        )}
        <ComboboxList className="max-h-[300px] overflow-y-auto p-1">
          {showCustom && (
            <ComboboxItem
              value={trimmed}
              label={trimmed}
              className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-ink data-highlighted:bg-surface-2"
            >
              <Plus size={14} className="text-ink-3" />
              {customLabel ? customLabel(trimmed) : <>使用「{trimmed}」</>}
            </ComboboxItem>
          )}
          {grouped.map(([group, items]) =>
            group ? (
              <ComboboxGroup key={group}>
                <ComboboxGroupLabel className="px-2 pb-1 pt-2 text-[11px] font-medium text-ink-3">
                  {group}
                </ComboboxGroupLabel>
                {items.map((option) => (
                  <ComboboxItem
                    key={option.value}
                    value={option.value}
                    label={optionText(option)}
                    keywords={option.keywords}
                    disabled={option.disabled}
                    className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm text-ink data-disabled:text-ink-4 data-highlighted:bg-surface-2"
                  >
                    {option.icon}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label ?? option.value}</span>
                      {option.description && (
                        <span className="block truncate text-[11px] text-ink-3">{option.description}</span>
                      )}
                    </span>
                    <ComboboxItemIndicator className="shrink-0 text-accent">
                      <Check size={14} aria-hidden="true" />
                    </ComboboxItemIndicator>
                  </ComboboxItem>
                ))}
              </ComboboxGroup>
            ) : (
              items.map((option) => (
                <ComboboxItem
                  key={option.value}
                  value={option.value}
                  label={optionText(option)}
                  keywords={option.keywords}
                  disabled={option.disabled}
                  className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm text-ink data-disabled:text-ink-4 data-highlighted:bg-surface-2"
                >
                  {option.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label ?? option.value}</span>
                    {option.description && (
                      <span className="block truncate text-[11px] text-ink-3">{option.description}</span>
                    )}
                  </span>
                  <ComboboxItemIndicator className="shrink-0 text-accent">
                    <Check size={14} aria-hidden="true" />
                  </ComboboxItemIndicator>
                </ComboboxItem>
              ))
            ),
          )}
        </ComboboxList>
      </ComboboxContent>
    </UiCombobox>
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
  label?: string;
  'aria-label'?: string;
}

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
  label,
  'aria-label': ariaLabel,
}: MultiComboboxProps) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const grouped = useMemo(() => groupOptions(options), [options]);
  const selected = new Set(value);
  const trimmed = query.trim();
  const showCustom = Boolean(
    allowCustom && trimmed && !options.some((o) => o.value === trimmed) && !selected.has(trimmed),
  );

  const dataItems = useMemo(
    () =>
      options.map((o) => ({
        value: o.value,
        label: optionText(o),
        keywords: o.keywords,
        disabled: o.disabled,
      })),
    [options],
  );

  const remove = (target: string) => {
    onChange(value.filter((v) => v !== target));
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {value.map((item) => {
        const option = options.find((o) => o.value === item);
        return (
          <span
            key={item}
            className="group inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2 pr-1 text-xs text-ink shadow-xs"
          >
            <span className="min-w-0 truncate">
              {renderChip ? renderChip(item, option) : (option?.label ?? item)}
            </span>
            {!disabled && (
              <UiButton
                type="button"
                aria-label={`移除 ${item}`}
                onClick={() => remove(item)}
                className="flex size-4 items-center justify-center rounded-full text-ink-4 hover:bg-surface-3 hover:text-ink"
              >
                <X size={10} strokeWidth={2.5} />
              </UiButton>
            )}
          </span>
        );
      })}
      {!disabled && (
        <UiCombobox
          multiple
          items={dataItems}
          value={value}
          onValueChange={(next) => onChange(next)}
          itemToLabel={(v) => {
            const match = options.find((o) => o.value === v);
            return match ? optionText(match) : v;
          }}
          allowCustomValue={allowCustom}
          loop
          query={query}
          onQueryChange={(next) => setQuery(next)}
          onOpenChange={(next) => {
            if (next) setQuery('');
          }}
          onOpenChangeComplete={(next) => {
            if (!next) button?.focus();
          }}
        >
          {trigger && isValidElement<{ children?: ReactNode }>(trigger) ? (
            <ComboboxTrigger ref={setButton} render={trigger}>
              {trigger.props.children}
            </ComboboxTrigger>
          ) : (
            <ComboboxTrigger
              ref={setButton}
              aria-label={ariaLabel ?? label}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-xs text-ink-3 transition hover:border-ink-3 hover:text-ink"
            >
              <Plus size={12} aria-hidden="true" />
              {placeholder}
            </ComboboxTrigger>
          )}
          <ComboboxContent
            anchor={button}
            align={align}
            sideOffset={6}
            collisionPadding={12}
            style={{ width: width ?? 280 }}
            className={cn(
              'z-50 m-0 flex max-h-[var(--available-height)] flex-col overflow-hidden rounded-xl border border-line bg-surface p-0 text-ink shadow-lg outline-none',
              'origin-[var(--transform-origin)] data-ending-style:animate-[sink_0.12s_ease-in_both] data-open:animate-pop',
            )}
          >
            <div className="border-b border-line p-1.5">
              <ComboboxInput
                autoFocus
                aria-label={ariaLabel ?? label ?? searchPlaceholder}
                placeholder={searchPlaceholder}
                className="h-8 w-full bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-4"
              />
            </div>
            {!showCustom && (
              <ComboboxEmpty className="px-2 py-6 text-center text-xs text-ink-3">{emptyText}</ComboboxEmpty>
            )}
            <ComboboxList className="max-h-[300px] overflow-y-auto p-1">
              {showCustom && (
                <ComboboxItem
                  value={trimmed}
                  label={trimmed}
                  className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-ink data-highlighted:bg-surface-2"
                >
                  <Plus size={14} className="text-ink-3" />
                  添加「{trimmed}」
                </ComboboxItem>
              )}
              {grouped.map(([group, items]) =>
                group ? (
                  <ComboboxGroup key={group}>
                    <ComboboxGroupLabel className="px-2 pb-1 pt-2 text-[11px] font-medium text-ink-3">
                      {group}
                    </ComboboxGroupLabel>
                    {items.map((option) => {
                      const checked = selected.has(option.value);
                      return (
                        <ComboboxItem
                          key={option.value}
                          value={option.value}
                          label={optionText(option)}
                          keywords={option.keywords}
                          disabled={option.disabled}
                          className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm text-ink data-disabled:text-ink-4 data-highlighted:bg-surface-2"
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
                            {option.description && (
                              <span className="block truncate text-[11px] text-ink-3">{option.description}</span>
                            )}
                          </span>
                        </ComboboxItem>
                      );
                    })}
                  </ComboboxGroup>
                ) : (
                  items.map((option) => {
                    const checked = selected.has(option.value);
                    return (
                      <ComboboxItem
                        key={option.value}
                        value={option.value}
                        label={optionText(option)}
                        keywords={option.keywords}
                        disabled={option.disabled}
                        className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm text-ink data-disabled:text-ink-4 data-highlighted:bg-surface-2"
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
                          {option.description && (
                            <span className="block truncate text-[11px] text-ink-3">{option.description}</span>
                          )}
                        </span>
                      </ComboboxItem>
                    );
                  })
                ),
              )}
            </ComboboxList>
          </ComboboxContent>
        </UiCombobox>
      )}
    </div>
  );
}

export function TagInput({
  value,
  onChange,
  placeholder = '输入后回车添加',
  validate,
  mono,
  className,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  validate?: (value: string) => string | null;
  mono?: boolean;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commitText = (raw: string) => {
    const next = raw.trim();
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
              <UiButton
                type="button"
                aria-label={`移除 ${item}`}
                onClick={() => onChange(value.filter((v) => v !== item))}
                className="flex size-4 items-center justify-center rounded text-ink-4 hover:bg-surface-3 hover:text-ink"
              >
                <X size={10} strokeWidth={2.5} />
              </UiButton>
            )}
          </span>
        ))}
        <UiInput
          value={draft}
          disabled={disabled}
          aria-label={ariaLabel ?? placeholder}
          onValueChange={(next) => {
            setDraft(next);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            // Enter/comma that confirms an IME candidate must not commit a half-typed tag
            // (keyCode 229 covers Safari, which clears isComposing before this keydown).
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              commitText(draft);
            } else if (event.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commitText(draft)}
          placeholder={value.length ? '' : placeholder}
          className={cn(
            'h-6 min-w-[120px] flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-4',
            mono && 'font-mono text-[12.5px]',
          )}
        />
        {!disabled && draft.trim() && (
          <UiButton
            type="button"
            aria-label="添加标签"
            onClick={() => commitText(draft)}
            className="inline-flex h-5 items-center rounded px-1.5 text-xs font-medium text-accent hover:bg-accent-soft"
          >
            添加
          </UiButton>
        )}
      </div>
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}
