'use client';
import { useEffect, useRef } from 'react';
const HISTORY_GUARD_KEY = '__proxymanagerUnsavedGuard';
const guards = new Map<symbol, string>();
let cleanup: (() => void) | null = null;
let unloadAllowedUntil = 0;
let guardedNavigation: ((action: () => void) => void) | null = null;

export function confirmUnsavedChanges(): boolean {
  return guards.size === 0 || window.confirm(guards.values().next().value!);
}

/** Use for router pushes and full-document navigation; confirm before side effects. */
export function navigateWithUnsavedGuard(action: () => void, fullDocument = false): void {
  if (!confirmUnsavedChanges()) return;
  navigateAfterSave(() => {
    if (fullDocument) unloadAllowedUntil = Date.now() + 1000;
    action();
  });
}

/** Only call after a successful save/delete has made abandoning this draft safe. */
export function navigateAfterSave(action: () => void): void {
  if (guardedNavigation) guardedNavigation(action);
  else action();
}

export function useUnsavedGuard(
  dirty: boolean,
  message = '有未保存的修改，离开将丢失。确定要离开吗？',
): void {
  const key = useRef(Symbol('draft'));
  useEffect(() => {
    if (!dirty) return;
    const id = key.current;
    guards.set(id, message);
    if (!cleanup) cleanup = installGuard();
    return () => {
      guards.delete(id);
      queueMicrotask(() => {
        if (guards.size === 0) {
          cleanup?.();
          cleanup = null;
        }
      });
    };
  }, [dirty, message]);
}

function installGuard(): () => void {
  const currentState =
    window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
  const existingGuardId = currentState[HISTORY_GUARD_KEY];
  const guardId =
    typeof existingGuardId === 'string'
      ? existingGuardId
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (typeof existingGuardId !== 'string') {
    window.history.pushState(
      { ...currentState, [HISTORY_GUARD_KEY]: guardId },
      '',
      window.location.href,
    );
  }

  let guardActive = true;
  let restoringGuard = false;
  let pendingAction: (() => void) | null = null;
  guardedNavigation = (action) => {
    if (guardActive && window.history.state?.[HISTORY_GUARD_KEY] === guardId) {
      pendingAction = action;
      window.history.back();
    } else {
      guardActive = false;
      action();
    }
  };
  let rearmTimer: number | null = null;
  let disposed = false;

  const rearmIfStillHere = (expectedHref: string) => {
    if (rearmTimer !== null) window.clearTimeout(rearmTimer);
    rearmTimer = window.setTimeout(() => {
      rearmTimer = null;
      if (disposed || guardActive || window.location.href !== expectedHref) return;
      const state =
        window.history.state && typeof window.history.state === 'object'
          ? window.history.state
          : {};
      window.history.pushState(
        { ...state, [HISTORY_GUARD_KEY]: guardId },
        '',
        window.location.href,
      );
      guardActive = true;
    }, 250);
  };

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (Date.now() < unloadAllowedUntil) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  const onClickCapture = (e: MouseEvent) => {
    if (!guardActive) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || anchor.target === '_blank') return;
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    // Same page (e.g. an in-page tab) — not a navigation away.
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    if (!confirmUnsavedChanges()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Remove the duplicate guard entry before allowing Next.js to navigate,
    // otherwise returning to this editor would require an extra Back press.
    e.preventDefault();
    e.stopPropagation();
    guardedNavigation?.(() => anchor.click());
  };
  document.addEventListener('click', onClickCapture, true);

  const onPopState = () => {
    if (!guardActive) return;
    if (restoringGuard) {
      restoringGuard = false;
      return;
    }
    if (pendingAction) {
      const action = pendingAction;
      pendingAction = null;
      guardActive = false;
      const expectedHref = window.location.href;
      queueMicrotask(() => {
        action();
        rearmIfStillHere(expectedHref);
      });
      return;
    }
    if (!confirmUnsavedChanges()) {
      restoringGuard = true;
      window.history.forward();
      return;
    }

    // The first Back only removed our duplicate entry. Continue once more to
    // the destination the user originally requested.
    guardActive = false;
    const expectedHref = window.location.href;
    window.history.back();
    rearmIfStillHere(expectedHref);
  };
  window.addEventListener('popstate', onPopState);

  return () => {
    disposed = true;
    guardedNavigation = null;
    if (rearmTimer !== null) window.clearTimeout(rearmTimer);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('click', onClickCapture, true);
    window.removeEventListener('popstate', onPopState);

    // Effects are mounted twice in React Strict Mode during development.
    // Defer cleanup so an immediate replacement setup can retain the same
    // protected history entry instead of pushing and popping repeatedly.
    queueMicrotask(() => {
      if (guards.size > 0 || !guardActive) return;
      if (window.history.state?.[HISTORY_GUARD_KEY] !== guardId) return;
      guardActive = false;
      window.history.back();
    });
  };
}
