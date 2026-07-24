'use client';

import { useEffect, useRef } from 'react';

const HISTORY_GUARD_KEY = '__proxymanagerUnsavedGuard';

/**
 * Warn before navigating away from an editor with unsaved changes (P1-6).
 *
 * Two layers:
 *  - `beforeunload` covers browser-level exits (refresh, tab close, typing a new
 *    URL, external links).
 *  - a capture-phase document click listener covers in-app SPA navigation —
 *    App Router has no built-in "block this navigation" hook, so we intercept
 *    clicks on internal `<a>` (which is what `next/link` renders) while dirty
 *    and confirm before letting them through.
 *  - a duplicate history entry catches browser back before it leaves the
 *    editor. Confirming removes the duplicate and continues the traversal;
 *    cancelling returns to the protected entry without unmounting the editor.
 *
 * The `subscriptions/_pipeline/OperatorWorkbench` had only the first layer; this
 * consolidates both so base / proxy-group / profile / rule-set editors get the
 * same protection against the most common loss path (clicking the sidebar).
 *
 * Not covered: purely programmatic `router.push()` with no anchor — those call
 * sites should confirm on their own. Modifier-clicks (new tab) pass through.
 */
export function useUnsavedGuard(
  dirty: boolean,
  message = '有未保存的修改，离开将丢失。确定要离开吗？',
): void {
  const effectGeneration = useRef(0);

  useEffect(() => {
    if (!dirty) return;

    const generation = ++effectGeneration.current;
    const isCurrentGeneration = () => effectGeneration.current === generation;
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
    let pendingAnchor: HTMLAnchorElement | null = null;
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
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    const onClickCapture = (e: MouseEvent) => {
      if (!guardActive) return;
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
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
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Remove the duplicate guard entry before allowing Next.js to navigate,
      // otherwise returning to this editor would require an extra Back press.
      e.preventDefault();
      e.stopPropagation();
      pendingAnchor = anchor;
      window.history.back();
    };
    document.addEventListener('click', onClickCapture, true);

    const onPopState = () => {
      if (!guardActive) return;
      if (restoringGuard) {
        restoringGuard = false;
        return;
      }
      if (pendingAnchor) {
        const anchor = pendingAnchor;
        pendingAnchor = null;
        guardActive = false;
        const expectedHref = window.location.href;
        queueMicrotask(() => {
          anchor.click();
          rearmIfStillHere(expectedHref);
        });
        return;
      }
      if (!window.confirm(message)) {
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
      if (rearmTimer !== null) window.clearTimeout(rearmTimer);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('popstate', onPopState);

      // Effects are mounted twice in React Strict Mode during development.
      // Defer cleanup so an immediate replacement setup can retain the same
      // protected history entry instead of pushing and popping repeatedly.
      queueMicrotask(() => {
        if (!isCurrentGeneration() || !guardActive) return;
        if (window.history.state?.[HISTORY_GUARD_KEY] !== guardId) return;
        guardActive = false;
        window.history.back();
      });
    };
  }, [dirty, message]);
}
