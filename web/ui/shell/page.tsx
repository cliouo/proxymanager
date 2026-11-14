'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

const widths = {
  narrow: 'max-w-[880px]',
  default: 'max-w-[1180px]',
  wide: 'max-w-[1440px]',
  full: 'max-w-none',
};

export function Page({
  children,
  width = 'default',
  className,
}: {
  children: ReactNode;
  width?: keyof typeof widths;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full px-5 pb-16 sm:px-8', widths[width], className)}>{children}</div>
  );
}

export function PageHeader({
  title,
  documentTitle,
  description,
  eyebrow,
  actions,
  back,
  children,
  className,
}: {
  title: ReactNode;
  /** Plain-text title for the browser tab when `title` is not a string. */
  documentTitle?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  children?: ReactNode;
  className?: string;
}) {
  const tabTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  return (
    <header className={cn('animate-rise pb-6 pt-7 sm:pt-9', className)}>
      {tabTitle && <title>{`${tabTitle} · ProxyManager`}</title>}
      {back && (
        <Link
          href={back.href}
          className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-ink-3 transition hover:text-ink"
        >
          <ArrowLeft size={13} />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          {eyebrow && <div className="mb-2 flex items-center gap-2 text-xs text-ink-3">{eyebrow}</div>}
          <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">{title}</h1>
          {description && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** A titled block inside a page. */
export function Block({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      {(title || actions) && (
        <div className="flex items-end justify-between gap-4">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Sticky bar that appears when a form has unsaved edits. */
export function SaveBar({
  visible,
  onSave,
  onDiscard,
  saving,
  message = '有未保存的修改',
  saveLabel = '保存',
}: {
  visible: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saving?: boolean;
  message?: ReactNode;
  saveLabel?: string;
}) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none sticky bottom-4 z-30 mt-6 flex justify-center">
      <div className="pointer-events-auto flex animate-rise items-center gap-3 rounded-xl border border-line bg-surface py-1.5 pl-4 pr-1.5 shadow-lg">
        <span className="flex items-center gap-2 text-[13px] text-ink-2">
          <span className="size-1.5 rounded-full bg-warn" />
          {message}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className="h-7 rounded-md px-2.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            放弃
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="flex h-7 items-center gap-1.5 rounded-md bg-inverse px-3 text-xs font-medium text-inverse-ink hover:bg-inverse/88 disabled:opacity-60"
          >
            {saving ? '保存中…' : saveLabel}
            <span className="rounded border border-inverse-ink/20 px-1 font-mono text-[10px] text-inverse-ink/70">⌘S</span>
          </button>
        </div>
      </div>
    </div>
  );
}
