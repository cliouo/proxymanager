'use client';

import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Dialog as UiDialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@ui-sdk/react/dialog';
import {
  Menu as UiMenu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '@ui-sdk/react/menu';
import {
  Popover as UiPopover,
  PopoverClose as UiPopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@ui-sdk/react/popover';
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import { Check, ChevronRight, X } from 'lucide-react';
import { cn } from '@/ui/lib/cn';
import { Button } from './button';
import {
  ASSISTANT_PERSISTENT_SELECTORS,
  shouldCancelAssistantFocusOut,
  useIsolateBackgroundForAgent,
  useWorkspaceOverlayScope,
} from './overlay-scope';

/**
 * Guard non-modal Dialog/Sheet close callbacks so clicking an external same-origin
 * navigation link (e.g. a sidebar `<Link>` while the AI assistant is open) does not
 * let `onOpenChange(false)` run a page's `router.replace(...)` and cancel the navigation.
 */
function useGuardedOpenChange(open: boolean, onOpenChange: (next: boolean) => void) {
  const leavingRef = useRef(false);

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      leavingRef.current = false;
      return;
    }
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    const markIfLeaving = (event: Event) => {
      const node = event.target instanceof Element ? event.target : null;
      const anchor = node?.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      try {
        const resolved = new URL(anchor.href, window.location.href);
        if (resolved.origin === window.location.origin && resolved.pathname !== window.location.pathname) {
          leavingRef.current = true;
          if (resetTimer) clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            leavingRef.current = false;
            resetTimer = null;
          }, 1000);
        }
      } catch {
        /* ignore malformed href */
      }
    };
    document.addEventListener('pointerdown', markIfLeaving, true);
    document.addEventListener('click', markIfLeaving, true);
    return () => {
      if (resetTimer) clearTimeout(resetTimer);
      document.removeEventListener('pointerdown', markIfLeaving, true);
      document.removeEventListener('click', markIfLeaving, true);
    };
  }, [open]);

  return (next: boolean) => {
    if (!next && leavingRef.current) return;
    onOpenChange(next);
  };
}

function normalizeTrigger(
  trigger: ReactNode,
  extraProps?: Record<string, string | undefined>,
): ReactElement<{ children?: ReactNode }> | null {
  if (!isValidElement<{ children?: ReactNode; native?: boolean }>(trigger)) return null;
  const patch: Record<string, unknown> = {};
  if (trigger.type === Button) patch.native = true;
  if (extraProps) {
    for (const [k, v] of Object.entries(extraProps)) {
      if (v !== undefined) patch[k] = v;
    }
  }
  return Object.keys(patch).length > 0 ? cloneElement(trigger, patch) : trigger;
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
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
  const contentRef = useRef<HTMLDivElement>(null);
  const { scopedContainer, keepAssistantInteractive } = useWorkspaceOverlayScope();
  const isScoped = Boolean(scopedContainer);
  const handleOpenChange = useGuardedOpenChange(open, onOpenChange);
  useIsolateBackgroundForAgent(open, contentRef);

  const tree = (
    <UiDialog
      open={open}
      onOpenChange={handleOpenChange}
      modal={keepAssistantInteractive ? false : true}
      persistentElements={keepAssistantInteractive ? ASSISTANT_PERSISTENT_SELECTORS : undefined}
    >
      <DialogBackdrop
        onClick={keepAssistantInteractive ? () => handleOpenChange(false) : undefined}
        className={cn(
          isScoped ? 'pointer-events-auto absolute inset-0 z-10' : 'fixed inset-0 z-50',
          'bg-overlay backdrop-blur-[1.5px] data-ending-style:animate-[fade-out_0.16s_ease-in_both] data-open:animate-fade-in',
        )}
      />
      <DialogContent
        ref={contentRef}
        inline={keepAssistantInteractive || undefined}
        initialFocus={() => contentRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? null}
        className={cn(
          isScoped
            ? 'pointer-events-auto absolute left-1/2 top-[min(14vh,120px)] z-20 max-h-[calc(100%-min(14vh,120px)-24px)]'
            : 'fixed left-1/2 top-[min(14vh,120px)] z-50 max-h-[calc(100dvh-min(14vh,120px)-24px)]',
          'm-0 flex w-[calc(100%-24px)] -translate-x-1/2 flex-col',
          'overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl outline-none',
          'data-ending-style:animate-[sink_0.16s_ease-in_both] data-open:animate-pop',
          dialogSizes[size],
          className,
        )}
      >
        {!bare && (title || description) ? (
          <div className="flex items-start gap-4 px-5 pb-1 pt-5">
            <div className="min-w-0 flex-1">
              {title && (
                <DialogTitle className="text-md font-semibold tracking-tight text-ink">{title}</DialogTitle>
              )}
              {description ? (
                <DialogDescription className="mt-1 text-sm leading-relaxed text-ink-2">
                  {description}
                </DialogDescription>
              ) : (
                <DialogDescription className="sr-only">
                  {typeof title === 'string' ? title : '对话框'}
                </DialogDescription>
              )}
            </div>
            <DialogClose
              aria-label="关闭"
              className="-mr-1.5 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-2 hover:text-ink"
            >
              <X size={16} strokeWidth={1.75} />
            </DialogClose>
          </div>
        ) : (
          <>
            <DialogTitle className="sr-only">{typeof title === 'string' ? title : '对话框'}</DialogTitle>
            <DialogDescription className="sr-only">对话框</DialogDescription>
          </>
        )}
        <div className={cn('min-h-0 flex-1 overflow-y-auto', !bare && 'px-5 py-4')}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
            {footer}
          </div>
        )}
      </DialogContent>
    </UiDialog>
  );

  return scopedContainer ? createPortal(tree, scopedContainer) : tree;
}

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
  const contentRef = useRef<HTMLDivElement>(null);
  const { scopedContainer, keepAssistantInteractive } = useWorkspaceOverlayScope();
  const isScoped = Boolean(scopedContainer);
  const handleOpenChange = useGuardedOpenChange(open, onOpenChange);
  useIsolateBackgroundForAgent(open, contentRef);

  const tree = (
    <UiDialog
      open={open}
      onOpenChange={handleOpenChange}
      modal={keepAssistantInteractive ? false : true}
      persistentElements={keepAssistantInteractive ? ASSISTANT_PERSISTENT_SELECTORS : undefined}
    >
      <DialogBackdrop
        onClick={keepAssistantInteractive ? () => handleOpenChange(false) : undefined}
        className={cn(
          isScoped ? 'pointer-events-auto absolute inset-0 z-10' : 'fixed inset-0 z-50',
          'bg-overlay data-ending-style:animate-[fade-out_0.18s_ease-in_both] data-open:animate-fade-in',
        )}
      />
      <DialogContent
        ref={contentRef}
        inline={keepAssistantInteractive || undefined}
        style={{ width: isScoped ? `min(${width}px, calc(100% - 16px))` : `min(${width}px, calc(100vw - 16px))` }}
        className={cn(
          isScoped
            ? 'pointer-events-auto absolute bottom-2 right-2 top-2 z-20'
            : 'fixed bottom-2 right-2 top-2 z-50',
          'm-0 flex flex-col overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl outline-none',
          'data-ending-style:animate-[slide-out-right_0.2s_ease-in_both] data-open:animate-[slide-in-right_0.38s_var(--ease-out-expo)_both]',
        )}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-md font-semibold tracking-tight text-ink">{title ?? '详情'}</DialogTitle>
            {description ? (
              <DialogDescription className="mt-0.5 text-xs text-ink-3">{description}</DialogDescription>
            ) : (
              <DialogDescription className="sr-only">侧边面板</DialogDescription>
            )}
          </div>
          {headerExtra}
          <DialogClose
            aria-label="关闭"
            className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-2 hover:text-ink"
          >
            <X size={16} strokeWidth={1.75} />
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
            {footer}
          </div>
        )}
      </DialogContent>
    </UiDialog>
  );

  return scopedContainer ? createPortal(tree, scopedContainer) : tree;
}

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
  const { keepAssistantInteractive } = useWorkspaceOverlayScope();
  const triggerEl = normalizeTrigger(trigger);
  return (
    <UiPopover
      open={open}
      onOpenChange={(next, details) => {
        if (!next && shouldCancelAssistantFocusOut(details, keepAssistantInteractive)) {
          details.cancel();
          return;
        }
        onOpenChange?.(next);
      }}
      modal={modal}
    >
      {triggerEl ? (
        <PopoverTrigger render={triggerEl}>{triggerEl.props.children}</PopoverTrigger>
      ) : (
        <PopoverTrigger>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          'z-50 m-0 max-h-[var(--available-height)] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-lg outline-none',
          'origin-[var(--transform-origin)] data-ending-style:animate-[sink_0.12s_ease-in_both] data-open:animate-pop',
          className,
        )}
      >
        {children}
      </PopoverContent>
    </UiPopover>
  );
}

export const PopoverClose = UiPopoverClose;

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
  // Non-interactive inline tags (span/time) lack an accessible name and can live inside <p>; use native title.
  if (
    isValidElement<{ title?: string }>(children) &&
    typeof children.type === 'string' &&
    children.type !== 'button' &&
    children.type !== 'a'
  ) {
    const title = typeof content === 'string' ? (shortcut ? `${content} (${shortcut})` : content) : undefined;
    return title && !children.props.title ? cloneElement(children as ReactElement<{ title?: string }>, { title }) : <>{children}</>;
  }
  return (
    <UiTooltip delay={350}>
      {isValidElement<{ children?: ReactNode }>(children) ? (
        <TooltipTrigger render={children}>{children.props.children}</TooltipTrigger>
      ) : (
        <TooltipTrigger>{children}</TooltipTrigger>
      )}
      <TooltipContent
        side={side}
        sideOffset={6}
        collisionPadding={8}
        className="z-[60] m-0 flex max-w-xs items-center gap-2 rounded-md border-0 bg-inverse px-2 py-1 text-xs text-inverse-ink shadow-md data-ending-style:animate-[fade-out_0.1s_both] data-open:animate-fade-in"
      >
        {content}
        {shortcut && (
          <span className="rounded border border-inverse-ink/20 px-1 font-mono text-[10px] text-inverse-ink/70">
            {shortcut}
          </span>
        )}
      </TooltipContent>
    </UiTooltip>
  );
}

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
  confirm?: string;
  /** Target pathname if selecting this item triggers an in-app route navigation. */
  nav?: string;
  items?: MenuEntry[];
}

export type MenuEntry = MenuItemSpec | 'separator' | { heading: ReactNode };

const itemClass = cn(
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm text-ink outline-none',
  'data-highlighted:bg-surface-2 data-disabled:pointer-events-none data-disabled:text-ink-4',
);

function MenuItems({ items }: { items: MenuEntry[] }) {
  return (
    <>
      {items.map((entry, index) => {
        if (entry === 'separator') {
          return <MenuSeparator key={`sep-${index}`} className="mx-1 my-1 h-px bg-line" />;
        }
        if ('heading' in entry) {
          return (
            <MenuGroup key={`heading-${index}`}>
              <MenuGroupLabel className="px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-ink-3">
                {entry.heading}
              </MenuGroupLabel>
            </MenuGroup>
          );
        }
        const Icon = entry.icon;
        const itemKey = typeof entry.label === 'string' ? `${entry.label}-${index}` : `item-${index}`;
        if (entry.items) {
          return (
            <MenuSub key={itemKey}>
              <MenuSubTrigger className={cn(itemClass, 'data-open:bg-surface-2')}>
                {Icon && <Icon size={15} strokeWidth={1.75} className="text-ink-3" />}
                <span className="flex-1">{entry.label}</span>
                <ChevronRight size={14} className="text-ink-3" />
              </MenuSubTrigger>
              <MenuSubContent
                sideOffset={6}
                className="z-50 m-0 min-w-[180px] rounded-xl border border-line bg-surface p-1 text-ink shadow-lg data-open:animate-pop"
              >
                <MenuItems items={entry.items} />
              </MenuSubContent>
            </MenuSub>
          );
        }
        return (
          <MenuItem
            key={itemKey}
            value={typeof entry.label === 'string' ? entry.label : itemKey}
            disabled={entry.disabled}
            destructive={entry.tone === 'danger' || undefined}
            data-agent-confirm={entry.confirm}
            data-agent-nav={entry.nav}
            onSelect={() => entry.onSelect?.()}
            className={cn(itemClass, entry.tone === 'danger' && 'text-bad data-highlighted:bg-bad-soft')}
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
          </MenuItem>
        );
      })}
    </>
  );
}

function collectNavItemMap(items: MenuEntry[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  const walk = (entries: MenuEntry[]) => {
    for (const entry of entries) {
      if (entry === 'separator' || 'heading' in entry) continue;
      if (typeof entry.label === 'string' && entry.nav) out[entry.label] = entry.nav;
      if (entry.items) walk(entry.items);
    }
  };
  walk(items);
  return Object.keys(out).length > 0 ? out : null;
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
  const navMap = collectNavItemMap(items);
  const triggerEl = normalizeTrigger(
    trigger,
    navMap ? { 'data-agent-nav-items': JSON.stringify(navMap) } : undefined,
  );
  return (
    <UiMenu modal={false} onOpenChange={(next) => onOpenChange?.(next)}>
      {triggerEl ? (
        <MenuTrigger render={triggerEl}>{triggerEl.props.children}</MenuTrigger>
      ) : (
        <MenuTrigger>{trigger}</MenuTrigger>
      )}
      <MenuContent
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={10}
        className={cn(
          'z-50 m-0 max-h-[var(--available-height)] min-w-[200px] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-lg outline-none',
          'origin-[var(--transform-origin)] data-ending-style:animate-[sink_0.12s_ease-in_both] data-open:animate-pop',
          className,
        )}
      >
        <MenuItems items={items} />
      </MenuContent>
    </UiMenu>
  );
}
