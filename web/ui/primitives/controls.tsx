'use client';

import { useId, useMemo, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { Checkbox as UiCheckbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import {
  SegmentedControl as UiSegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '@ui-sdk/react/segmented-control';
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select';
import { Switch as UiSwitch, SwitchThumb } from '@ui-sdk/react/switch';
import { Tabs as UiTabs, TabsList, TabsPanel as UiTabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { motion } from 'motion/react';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  size = 'md',
  id,
  label,
  className,
  'data-agent-confirm': agentConfirm,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  label?: string;
  className?: string;
  'data-agent-confirm'?: string;
}) {
  const dims = size === 'sm' ? 'h-4 w-7' : 'h-[18px] w-8';
  const thumb = size === 'sm' ? 'size-3 data-checked:translate-x-3' : 'size-3.5 data-checked:translate-x-3.5';
  return (
    <UiSwitch
      id={id}
      aria-label={label}
      data-agent-confirm={agentConfirm}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onCheckedChange(next)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-200',
        'bg-line-strong data-checked:bg-accent disabled:opacity-40',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        dims,
        className,
      )}
    >
      <SwitchThumb
        className={cn(
          'block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-[var(--ease-spring)]',
          thumb,
        )}
      />
    </UiSwitch>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  label,
  className,
  id,
  'aria-label': ariaLabel,
}: {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  className?: string;
  id?: string;
  'aria-label'?: string;
}) {
  const autoId = useId();
  const box = (
    <UiCheckbox
      id={id ?? autoId}
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-surface shadow-xs transition-colors',
        'data-checked:border-accent data-checked:bg-accent data-indeterminate:border-accent data-indeterminate:bg-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40',
        !label && className,
      )}
    >
      <CheckboxIndicator className="text-accent-ink">
        {checked === 'indeterminate' ? <Minus size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
      </CheckboxIndicator>
    </UiCheckbox>
  );
  if (!label) return box;
  return (
    <label htmlFor={id ?? autoId} className={cn('inline-flex cursor-pointer items-center gap-2 text-sm text-ink', className)}>
      {box}
      {label}
    </label>
  );
}

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
  layoutId: _layoutId,
  stretch,
  label,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  size?: 'sm' | 'md';
  className?: string;
  layoutId?: string;
  stretch?: boolean;
  label?: string;
  'aria-label'?: string;
}) {
  void _layoutId;
  return (
    <UiSegmentedControl
      aria-label={ariaLabel ?? label}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next as T);
      }}
      className={cn(
        'relative isolate inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5',
        stretch && 'flex w-full',
        className,
      )}
    >
      <SegmentedControlIndicator
        className={cn(
          'pointer-events-none absolute -z-10 rounded-md border border-line bg-surface shadow-sm',
          'top-[var(--segmented-control-indicator-top)] left-[var(--segmented-control-indicator-left)]',
          'h-[var(--segmented-control-indicator-height)] w-[var(--segmented-control-indicator-width)]',
          'transition-[top,left,width,height] duration-200 ease-[var(--ease-spring)]',
          'data-[activation-direction=none]:transition-none',
        )}
      />
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <SegmentedControlItem
            key={option.value}
            value={option.value}
            title={option.hint}
            disabled={option.disabled}
            className={cn(
              'relative flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors duration-150',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
              'text-ink-3 hover:text-ink-2 data-checked:text-ink',
              stretch && 'flex-1',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            <span className="relative z-10 flex items-center gap-1.5">
              {Icon && <Icon size={14} strokeWidth={1.75} />}
              {option.label}
            </span>
          </SegmentedControlItem>
        );
      })}
    </UiSegmentedControl>
  );
}

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
  label,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: TabSpec[];
  className?: string;
  children?: ReactNode;
  label?: string;
}) {
  const id = useId();
  return (
    <UiTabs
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      className={className}
    >
      {/* The hairline is an inset shadow so the list can scroll horizontally on narrow screens. */}
      <TabsList
        aria-label={label ?? '标签页'}
        className="relative flex items-center gap-5 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const active = tab.value === value;
          const Icon = tab.icon;
          return (
            <TabsTab
              key={tab.value}
              value={tab.value}
              className={cn(
                'relative flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium outline-none transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
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
            </TabsTab>
          );
        })}
      </TabsList>
      {children}
    </UiTabs>
  );
}

export function TabPanel({
  forceMount,
  keepMounted,
  className,
  ...props
}: ComponentProps<typeof UiTabsPanel> & { forceMount?: boolean }) {
  return (
    <UiTabsPanel
      keepMounted={forceMount || keepMounted}
      className={cn('[&:not([data-selected])]:hidden', className)}
      {...props}
    />
  );
}

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
  label,
  'aria-label': ariaLabel,
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
  label?: string;
  'aria-label'?: string;
}) {
  const items = useMemo(
    () =>
      options.map((option) => ({
        value: option.value,
        label: typeof option.label === 'string' ? option.label : option.value,
        disabled: option.disabled,
      })),
    [options],
  );

  return (
    <UiSelect
      items={items}
      value={value ?? null}
      onValueChange={(v) => {
        if (v !== null) onValueChange(v as T);
      }}
      disabled={disabled}
      placeholder={placeholder}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel ?? label}
        aria-invalid={invalid || undefined}
        className={cn(
          'inline-flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm text-ink shadow-xs',
          'transition-[border-color,box-shadow] hover:border-line-strong focus:border-accent focus:shadow-[var(--ring)] focus:outline-none',
          'data-placeholder:text-ink-4 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3 aria-[invalid=true]:border-bad',
          size === 'sm' ? 'h-7 text-xs' : 'h-8',
          mono && 'font-mono text-[12.5px]',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {value !== undefined && renderValue ? renderValue(value) : <SelectValue placeholder={placeholder} />}
        </span>
        <ChevronDown size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
      </SelectTrigger>
      <SelectContent
        align={align}
        sideOffset={6}
        collisionPadding={10}
        className={cn(
          'z-50 m-0 max-h-[min(360px,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-lg outline-none',
          'origin-[var(--transform-origin)] data-open:animate-pop',
        )}
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            label={typeof option.label === 'string' ? option.label : undefined}
            disabled={option.disabled}
            className={cn(
              'relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-2 pr-8 text-sm text-ink outline-none',
              'data-highlighted:bg-surface-2 data-disabled:text-ink-4',
              mono && 'font-mono text-[12.5px]',
            )}
          >
            <div className="min-w-0">
              <div>{option.label}</div>
              {option.description && <div className="text-xs text-ink-3">{option.description}</div>}
            </div>
            <SelectItemIndicator className="absolute right-2 text-accent">
              <Check size={14} aria-hidden="true" />
            </SelectItemIndicator>
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  );
}
