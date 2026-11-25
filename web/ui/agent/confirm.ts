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

    const message = step.confirm || `允许执行 ${step.label ?? step.ref} 的操作？`;
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
