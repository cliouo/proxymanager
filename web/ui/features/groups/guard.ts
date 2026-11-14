'use client';

import { confirmAction } from '@/ui/primitives';

/** The open editor registers how to tell whether it holds unsaved edits. */
let check: (() => boolean) | null = null;

export function registerDirtyCheck(fn: () => boolean): () => void {
  check = fn;
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
    description: '当前策略组还有修改没有保存，切换后这些修改会丢失。',
    confirmText: '放弃修改',
    tone: 'danger',
  });
}
