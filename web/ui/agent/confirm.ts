'use client';

import { useSyncExternalStore } from 'react';
import type { AgentAction } from '@ui-sdk/react/agent';

export interface AgentConfirmRequest {
  id: number;
  step: AgentAction;
  message: string;
  resolve: (approved: boolean) => void;
  cleanup: () => void;
}

let nextId = 1;
let queue: AgentConfirmRequest[] = [];
let inlineHostCount = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getCurrent(): AgentConfirmRequest | null {
  return queue[0] ?? null;
}

function hasInlineHost(): boolean {
  return inlineHostCount > 0;
}

export function registerInlineConfirmHost(): () => void {
  inlineHostCount += 1;
  emit();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    inlineHostCount = Math.max(0, inlineHostCount - 1);
    emit();
  };
}

export function useHasInlineConfirmHost(): boolean {
  return useSyncExternalStore(subscribe, hasInlineHost, () => false);
}

function accessibleName(el: HTMLElement): string {
  return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
}

function isEligibleTarget(el: HTMLElement): boolean {
  if (el.closest('[data-agent-hidden]')) return false;
  if (el.hasAttribute('hidden')) return false;
  return true;
}

function matchInRoot(root: ParentNode, step: AgentAction): HTMLElement | null {
  const candidates = [...root.querySelectorAll<HTMLElement>('[data-agent-confirm]')].filter(isEligibleTarget);
  if (!candidates.length) return null;

  const confirmText = step.confirm && step.confirm !== 'true' ? step.confirm : null;
  const labelText = (
    (typeof step.args[0] === 'string' && step.args[0].trim()) ||
    step.label?.trim() ||
    ''
  );

  if (confirmText && labelText) {
    const exact = candidates.find(
      (el) => el.getAttribute('data-agent-confirm') === confirmText && accessibleName(el) === labelText,
    );
    if (exact) return exact;
  }
  if (confirmText) {
    const byConfirm = candidates.find((el) => el.getAttribute('data-agent-confirm') === confirmText);
    if (byConfirm) return byConfirm;
  }
  if (labelText) {
    const byLabel = candidates.find((el) => accessibleName(el) === labelText);
    if (byLabel) return byLabel;
  }
  return null;
}

export function findConfirmTargetElement(step: AgentAction): HTMLElement | null {
  if (typeof document === 'undefined' || step.component === 'tool') return null;
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]')].filter(
    (el) => !el.closest('[data-agent-hidden]'),
  );
  for (let i = dialogs.length - 1; i >= 0; i -= 1) {
    const found = matchInRoot(dialogs[i], step);
    if (found) return found;
  }
  return matchInRoot(document, step);
}

export function requestAgentConfirm(
  step: AgentAction,
  options?: { signal?: AbortSignal },
): Promise<boolean> {
  if (options?.signal?.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const id = nextId++;
    const signal = options?.signal;
    const onAbort = () => resolveAgentConfirm(id, false);
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const confirmText = step.confirm && step.confirm !== 'true' ? step.confirm : null;
    const message = confirmText || `允许执行「${step.label ?? step.ref}」？`;
    queue = [...queue, { id, step, message, resolve, cleanup }];
    emit();
  });
}

export function resolveAgentConfirm(id: number, approved: boolean): void {
  const index = queue.findIndex((item) => item.id === id);
  if (index === -1) return;
  const [target] = queue.splice(index, 1);
  queue = [...queue];
  target.cleanup();
  emit();
  target.resolve(approved);
}

export function clearAgentConfirms(): void {
  const pending = queue;
  queue = [];
  for (const item of pending) {
    item.cleanup();
    item.resolve(false);
  }
  emit();
}

export function usePendingAgentConfirm(): AgentConfirmRequest | null {
  return useSyncExternalStore(subscribe, getCurrent, () => null);
}
