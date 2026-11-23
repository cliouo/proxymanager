'use client';

import { confirmAction } from '@/ui/primitives';

/** The open editor registers how to tell whether it holds unsaved edits. */
let check: (() => boolean) | null = null;
const GROUP_DESCRIPTION = '当前策略组还有修改没有保存，切换后这些修改会丢失。';
const GROUP_CONFIRMATION = {
  title: '放弃未保存的修改？', description: GROUP_DESCRIPTION, confirmText: '放弃修改', tone: 'danger',
} as const;
export const PIPELINE_LEAVE_CONFIRMATION = {
  title: '离开前不保存修改？', description: '处理流程有未保存的修改，离开后会丢失。',
  confirmText: '放弃修改并离开', cancelText: '留下', tone: 'danger',
} as const;
type LeaveConfirmation = Parameters<typeof confirmAction>[0];
let confirmation: LeaveConfirmation = GROUP_CONFIRMATION;

export function registerDirtyCheck(fn: () => boolean, message: string | LeaveConfirmation = GROUP_DESCRIPTION): () => void {
  check = fn;
  confirmation = typeof message === 'string' ? { ...GROUP_CONFIRMATION, description: message } : message;
  return () => {
    if (check === fn) check = null;
  };
}

export const hasUnsavedEdits = () => !!check?.();

/** Ask before throwing away unsaved edits. Resolves true when it is fine to leave. */
export async function confirmLeave(): Promise<boolean> {
  if (!hasUnsavedEdits()) return true;
  return confirmAction(confirmation);
}

export async function navigateWithGuard(navigate: () => void, href?: string): Promise<void> {
  const target = href && typeof window !== 'undefined' ? new URL(href, window.location.href) : null;
  const samePage = target && target.origin === window.location.origin && target.pathname === window.location.pathname;
  if (samePage || await confirmLeave()) navigate();
}
