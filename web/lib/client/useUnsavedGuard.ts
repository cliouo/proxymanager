'use client';

import { useEffect } from 'react';

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
  message = '有未保存的修改,离开将丢失。确定要离开吗?',
): void {
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    const onClickCapture = (e: MouseEvent) => {
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
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClickCapture, true);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [dirty, message]);
}
