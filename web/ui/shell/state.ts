'use client';

import { useSyncExternalStore } from 'react';

/** App-wide UI state (panels, palette) — a tiny external store, no provider. */
export interface UiState {
  paletteOpen: boolean;
  assistantOpen: boolean;
  assistantDocked: boolean;
  shareOpen: boolean;
  /** Pre-filled prompt handed to the assistant when it opens. */
  assistantDraft: string | null;
  sidebarCollapsed: boolean;
}

let state: UiState = {
  paletteOpen: false,
  assistantOpen: false,
  assistantDocked: false,
  shareOpen: false,
  assistantDraft: null,
  sidebarCollapsed: false,
};

const listeners = new Set<() => void>();

export function setUi(patch: Partial<UiState> | ((current: UiState) => Partial<UiState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  if ('sidebarCollapsed' in next && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem('pm.sidebar-collapsed', state.sidebarCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  for (const l of listeners) l();
}

export function getUi(): UiState {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const serverState: UiState = { ...state };

export function useUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(serverState),
  );
}

export function hydrateUiFromStorage() {
  try {
    const collapsed = window.localStorage.getItem('pm.sidebar-collapsed') === '1';
    if (collapsed !== state.sidebarCollapsed) setUi({ sidebarCollapsed: collapsed });
  } catch {
    /* ignore */
  }
}

export const openAssistant = (draft?: string) => setUi({ assistantOpen: true, assistantDraft: draft ?? null });
export const openPalette = () => setUi({ paletteOpen: true });
export const openShare = () => setUi({ shareOpen: true });
