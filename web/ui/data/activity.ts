'use client';

import { useSyncExternalStore } from 'react';

/** Count of admin-API requests in flight; drives the top activity bar. */
let inflight = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function trackRequest<T>(promise: Promise<T>): Promise<T> {
  inflight++;
  emit();
  return promise.finally(() => {
    inflight--;
    emit();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNetworkBusy(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => inflight > 0,
    () => false,
  );
}
