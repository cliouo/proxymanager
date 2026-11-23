'use client';

import { confirmAction } from '@/ui/primitives';

/** The open editor registers how to tell whether it holds unsaved edits. */
let check: (() => boolean) | null = null;
const GROUP_DESCRIPTION = '当前策略组还有修改没有保存，切换后这些修改会丢失。';
let description = GROUP_DESCRIPTION;

export function registerDirtyCheck(fn: () => boolean, message = GROUP_DESCRIPTION): () => void {
  check = fn;
  description = message;
  return () => {
    if (check === fn) check = null;
  };
}

export const hasUnsavedEdits = () => !!check?.();

/** Ask before throwing away unsaved edits. Resolves true when it is fine to leave. */
export async function confirmLeave(): Promise<boolean> {
  if (!hasUnsavedEdits()) return true;
  return confirmAction({
    title: '放弃未保存的修改？',
    description,
    confirmText: '放弃修改',
    tone: 'danger',
  });
}

export async function navigateWithGuard(navigate: () => void, href?: string): Promise<void> {
  const target = href && typeof window !== 'undefined' ? new URL(href, window.location.href) : null;
  const samePage = target && target.origin === window.location.origin && target.pathname === window.location.pathname;
  if (samePage || await confirmLeave()) navigate();
}
