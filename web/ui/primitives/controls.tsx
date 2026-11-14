'use client';

import { useId, type ComponentType, type ReactNode } from 'react';
import { Checkbox as RCheckbox, Select as RSelect, Switch as RSwitch, Tabs as RTabs } from 'radix-ui';
import { motion } from 'motion/react';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

/* ─── Switch ─────────────────────────────────────────────────────────── */

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  size = 'md',
  id,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  label?: string;
  className?: string;
}) {
  const dims = size === 'sm' ? 'h-4 w-7' : 'h-[18px] w-8';
  const thumb = size === 'sm' ? 'size-3 data-[state=checked]:translate-x-3' : 'size-3.5 data-[state=checked]:translate-x-3.5';
  return (
    <RSwitch.Root
      id={id}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-200',
        'bg-line-strong data-[state=checked]:bg-accent disabled:opacity-40',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        dims,
        className,
      )}
    >
      <RSwitch.Thumb
        className={cn(
          'block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-[var(--ease-spring)]',
          thumb,
        )}
      />
    </RSwitch.Root>
  );
}

/* ─── Checkbox ───────────────────────────────────────────────────────── */

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  label,
  className,
  id,
}: {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  className?: string;
  id?: string;
}) {
  const autoId = useId();
  const box = (
    <RCheckbox.Root
      id={id ?? autoId}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-surface shadow-xs transition-colors',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40',
        !label && className,
      )}
    >
      <RCheckbox.Indicator className="text-accent-ink">
        {checked === 'indeterminate' ? <Minus size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
  if (!label) return box;
  return (
    <label htmlFor={id ?? autoId} className={cn('inline-flex cursor-pointer items-center gap-2 text-sm text-ink', className)}>
      {box}
      {label}
    </label>
  );
}

/* ─── Segmented control ──────────────────────────────────────────────── */

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  hint?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  layoutId,
  stretch,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  size?: 'sm' | 'md';
  className?: string;
  layoutId?: string;
  stretch?: boolean;
}) {
  const autoId = useId();
  const pillId = layoutId ?? `seg-${autoId}`;
  return (
    <div
      role="radiogroup"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5',
        stretch && 'flex w-full',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors duration-150',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
              active ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
              stretch && 'flex-1',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                className="absolute inset-0 rounded-md border border-line bg-surface shadow-sm"
                transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {Icon && <Icon size={14} strokeWidth={1.75} />}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ─── Tabs (underline) ───────────────────────────────────────────────── */

export interface TabSpec {
  value: string;
  label: ReactNode;
  count?: number;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
}

export function Tabs({
  value,
  onValueChange,
  tabs,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: TabSpec[];
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className={className}>
      {/* The hairline is an inset shadow so the list can scroll horizontally on narrow screens. */}
      <RTabs.List className="relative flex items-center gap-5 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const active = tab.value === value;
          const Icon = tab.icon;
          return (
            <RTabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                'relative flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium outline-none transition-colors',
                active ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
              )}
            >
              {Icon && <Icon size={15} strokeWidth={1.75} />}
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className={cn(
                    'tnum rounded-full px-1.5 text-2xs font-medium',
                    active ? 'bg-ink text-panel' : 'bg-surface-3 text-ink-3',
                  )}
                >
                  {tab.count}
                </span>
              )}
              {active && (
                <motion.span
                  layoutId={`tab-${id}`}
                  className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-ink"
                  transition={{ type: 'spring', bounce: 0.12, duration: 0.4 }}
                />
              )}
            </RTabs.Trigger>
          );
        })}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}

export const TabPanel = RTabs.Content;

/* ─── Select ─────────────────────────────────────────────────────────── */

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder = '请选择',
  className,
  size = 'md',
  id,
  disabled,
  invalid,
  mono,
  align = 'start',
  renderValue,
}: {
  value: T | undefined;
  onValueChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  mono?: boolean;
  align?: 'start' | 'center' | 'end';
  renderValue?: (value: T) => ReactNode;
}) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <RSelect.Trigger
        id={id}
        aria-invalid={invalid || undefined}
        className={cn(
          'inline-flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm text-ink shadow-xs',
          'transition-[border-color,box-shadow] hover:border-line-strong focus:border-accent focus:shadow-[var(--ring)] focus:outline-none',
          'data-[placeholder]:text-ink-4 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3 aria-[invalid=true]:border-bad',
          size === 'sm' ? 'h-7 text-xs' : 'h-8',
          mono && 'font-mono text-[12.5px]',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {value !== undefined && renderValue ? renderValue(value) : <RSelect.Value placeholder={placeholder} />}
        </span>
        <RSelect.Icon>
          <ChevronDown size={14} className="text-ink-3" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          align={align}
          sideOffset={6}
          collisionPadding={10}
          className={cn(
            'z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line bg-surface shadow-lg',
            'origin-[var(--radix-select-content-transform-origin)] data-[state=open]:animate-pop',
          )}
        >
          <RSelect.Viewport className="p-1">
            {options.map((option) => (
              <RSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-2 pr-8 text-sm text-ink outline-none',
                  'data-[highlighted]:bg-surface-2 data-[disabled]:text-ink-4',
                  mono && 'font-mono text-[12.5px]',
                )}
              >
                <div className="min-w-0">
                  <RSelect.ItemText>{option.label}</RSelect.ItemText>
                  {option.description && <div className="text-xs text-ink-3">{option.description}</div>}
                </div>
                <RSelect.ItemIndicator className="absolute right-2 text-accent">
                  <Check size={14} />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
