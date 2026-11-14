'use client';

import { type ComponentType, type ReactNode } from 'react';
import { Dialog as RDialog, DropdownMenu, Popover as RPopover, Tooltip as RTooltip } from 'radix-ui';
import { Check, ChevronRight, X } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

/* ─── Dialog ─────────────────────────────────────────────────────────── */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  /** Hide the default header (render your own). */
  bare?: boolean;
}

const dialogSizes = {
  sm: 'max-w-[420px]',
  md: 'max-w-[540px]',
  lg: 'max-w-[720px]',
  xl: 'max-w-[960px]',
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
  bare,
}: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[1.5px] data-[state=closed]:animate-[fade-out_0.16s_ease-in_both] data-[state=open]:animate-fade-in" />
        <RDialog.Content
          className={cn(
            'fixed left-1/2 top-[min(14vh,120px)] z-50 flex max-h-[calc(100dvh-min(14vh,120px)-24px)] w-[calc(100%-24px)] -translate-x-1/2 flex-col',
            'overflow-hidden rounded-2xl border border-line bg-surface shadow-xl outline-none',
            'data-[state=closed]:animate-[sink_0.16s_ease-in_both] data-[state=open]:animate-pop',
            dialogSizes[size],
            className,
          )}
          onOpenAutoFocus={(event) => {
            const target = event.currentTarget as HTMLElement | null;
            const preferred = target?.querySelector<HTMLElement>('[data-autofocus]');
            if (preferred) {
              event.preventDefault();
              preferred.focus();
            }
          }}
        >
          {!bare && (title || description) ? (
            <div className="flex items-start gap-4 px-5 pb-1 pt-5">
              <div className="min-w-0 flex-1">
                {title && (
                  <RDialog.Title className="text-md font-semibold tracking-tight text-ink">{title}</RDialog.Title>
                )}
                {description ? (
                  <RDialog.Description className="mt-1 text-sm leading-relaxed text-ink-2">
                    {description}
                  </RDialog.Description>
                ) : (
                  <RDialog.Description className="sr-only">{typeof title === 'string' ? title : '对话框'}</RDialog.Description>
                )}
              </div>
              <RDialog.Close
                aria-label="关闭"
                className="-mr-1.5 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-2 hover:text-ink"
              >
                <X size={16} strokeWidth={1.75} />
              </RDialog.Close>
            </div>
          ) : (
            <>
              <RDialog.Title className="sr-only">{typeof title === 'string' ? title : '对话框'}</RDialog.Title>
              <RDialog.Description className="sr-only">对话框</RDialog.Description>
            </>
          )}
          <div className={cn('min-h-0 flex-1 overflow-y-auto', !bare && 'px-5 py-4')}>{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
              {footer}
            </div>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* ─── Sheet (side panel) ─────────────────────────────────────────────── */

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  headerExtra?: ReactNode;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 480,
  headerExtra,
}: SheetProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=closed]:animate-[fade-out_0.18s_ease-in_both] data-[state=open]:animate-fade-in" />
        <RDialog.Content
          style={{ width: `min(${width}px, calc(100vw - 16px))` }}
          className={cn(
            'fixed bottom-2 right-2 top-2 z-50 flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl outline-none',
            'data-[state=closed]:animate-[slide-out-right_0.2s_ease-in_both] data-[state=open]:animate-[slide-in-right_0.38s_var(--ease-out-expo)_both]',
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <RDialog.Title className="text-md font-semibold tracking-tight text-ink">{title ?? '详情'}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-0.5 text-xs text-ink-3">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">侧边面板</RDialog.Description>
              )}
            </div>
            {headerExtra}
            <RDialog.Close
              aria-label="关闭"
              className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-2 hover:text-ink"
            >
              <X size={16} strokeWidth={1.75} />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
              {footer}
            </div>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* ─── Popover ────────────────────────────────────────────────────────── */

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  className,
  modal,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
  className?: string;
  modal?: boolean;
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align={align}
          side={side}
          sideOffset={sideOffset}
          collisionPadding={12}
          className={cn(
            'z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg outline-none',
            'origin-[var(--radix-popover-content-transform-origin)] data-[state=closed]:animate-[sink_0.12s_ease-in_both] data-[state=open]:animate-pop',
            className,
          )}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export const PopoverClose = RPopover.Close;

/* ─── Tooltip ────────────────────────────────────────────────────────── */

export function Tooltip({
  content,
  children,
  side = 'top',
  shortcut,
  disabled,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  shortcut?: string;
  disabled?: boolean;
}) {
  if (disabled || !content) return <>{children}</>;
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] flex max-w-xs items-center gap-2 rounded-md bg-inverse px-2 py-1 text-xs text-inverse-ink shadow-md data-[state=closed]:animate-[fade-out_0.1s_both] data-[state=delayed-open]:animate-fade-in"
        >
          {content}
          {shortcut && (
            <span className="rounded border border-inverse-ink/20 px-1 font-mono text-[10px] text-inverse-ink/70">
              {shortcut}
            </span>
          )}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/* ─── Dropdown menu ──────────────────────────────────────────────────── */

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export interface MenuItemSpec {
  label: ReactNode;
  icon?: IconComponent;
  onSelect?: () => void;
  shortcut?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  checked?: boolean;
  hint?: ReactNode;
  items?: MenuEntry[];
}

export type MenuEntry = MenuItemSpec | 'separator' | { heading: ReactNode };

const itemClass = cn(
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm text-ink outline-none',
  'data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:text-ink-4',
);

function MenuItems({ items }: { items: MenuEntry[] }) {
  return (
    <>
      {items.map((entry, index) => {
        if (entry === 'separator') {
          return <DropdownMenu.Separator key={index} className="mx-1 my-1 h-px bg-line" />;
        }
        if ('heading' in entry) {
          return (
            <DropdownMenu.Label key={index} className="px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-ink-3">
              {entry.heading}
            </DropdownMenu.Label>
          );
        }
        const Icon = entry.icon;
        if (entry.items) {
          return (
            <DropdownMenu.Sub key={index}>
              <DropdownMenu.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-surface-2')}>
                {Icon && <Icon size={15} strokeWidth={1.75} className="text-ink-3" />}
                <span className="flex-1">{entry.label}</span>
                <ChevronRight size={14} className="text-ink-3" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  sideOffset={6}
                  className="z-50 min-w-[180px] rounded-xl border border-line bg-surface p-1 shadow-lg data-[state=open]:animate-pop"
                >
                  <MenuItems items={entry.items} />
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          );
        }
        return (
          <DropdownMenu.Item
            key={index}
            disabled={entry.disabled}
            onSelect={() => entry.onSelect?.()}
            className={cn(itemClass, entry.tone === 'danger' && 'text-bad data-[highlighted]:bg-bad-soft')}
          >
            {Icon ? (
              <Icon
                size={15}
                strokeWidth={1.75}
                className={entry.tone === 'danger' ? 'text-bad' : 'text-ink-3'}
              />
            ) : entry.checked !== undefined ? (
              <span className="flex w-[15px] justify-center">
                {entry.checked && <Check size={14} className="text-accent" />}
              </span>
            ) : null}
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.hint && <span className="text-xs text-ink-3">{entry.hint}</span>}
            {entry.shortcut && <span className="font-mono text-2xs text-ink-4">{entry.shortcut}</span>}
          </DropdownMenu.Item>
        );
      })}
    </>
  );
}

export function Menu({
  trigger,
  items,
  align = 'end',
  side = 'bottom',
  className,
  onOpenChange,
}: {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu.Root modal={false} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className={cn(
            'z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[200px] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg outline-none',
            'origin-[var(--radix-dropdown-menu-content-transform-origin)] data-[state=closed]:animate-[sink_0.12s_ease-in_both] data-[state=open]:animate-pop',
            className,
          )}
        >
          <MenuItems items={items} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
