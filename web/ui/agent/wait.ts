'use client';

import { elementOf } from '@ui-sdk/react/observe';
import type { AppAgent } from './bridge';

export interface WaitForTargetOptions {
  /** Substring to wait for in component labels/values or visible main text (case-insensitive). */
  text?: string;
  /** Component kind to wait for in agent snapshot (e.g. "data-view", "button", "input"). */
  component?: string;
  /** Max wait time in ms (clamped to 200..15000, default 8000). */
  timeoutMs?: number;
  signal?: AbortSignal;
  agent?: AppAgent;
}

export interface WaitForTargetResult {
  found: boolean;
  route: string;
  waitedMs: number;
  loading: boolean;
  hint?: string;
}

const SKELETON_SELECTOR = '.skeleton, [aria-busy="true"]';

function mainRoot(): Element | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('main') ?? document.body;
}

function isHiddenFromAgent(el: Element): boolean {
  return !!el.closest('[data-agent-hidden]');
}

/** True when `#main` currently renders visible skeleton placeholders or aria-busy regions. */
export function hasMainSkeletons(): boolean {
  const root = mainRoot();
  if (!root) return false;
  const nodes = root.querySelectorAll(SKELETON_SELECTOR);
  for (const node of nodes) {
    if (!isHiddenFromAgent(node)) return true;
  }
  return false;
}

function visibleMainText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) parts.push(node.textContent);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.hasAttribute('data-agent-hidden') || el.getAttribute('aria-hidden') === 'true') return;
      for (const child of el.childNodes) walk(child);
    }
  };
  walk(root);
  return parts.join(' ');
}

function isInsideMainScope(ref: unknown): boolean {
  if (typeof document === 'undefined' || typeof ref !== 'string') return true;
  const main = document.getElementById('main');
  if (!main) return true;
  let el: Element | null = null;
  try {
    el = elementOf(ref);
  } catch {
    el = null;
  }
  if (!el) return true;
  if (el.closest('[data-takeover-sidebar], nav[aria-label="主导航"]')) return false;
  if (main.contains(el)) return true;
  return Boolean(el.closest('[role="dialog"], [role="alertdialog"]'));
}

function snapshotHasMatch(
  agent: AppAgent | undefined,
  needle: string | null,
  componentKind: string | null,
): boolean {
  if (!agent) return false;
  try {
    const items = agent.snapshot();
    for (const item of items) {
      const rec = item as unknown as Record<string, unknown>;
      if (!isInsideMainScope(rec.ref)) continue;
      const kind = typeof rec.component === 'string' ? rec.component.toLowerCase() : '';
      if (componentKind && kind !== componentKind) continue;
      if (!needle) return true;
      for (const field of [rec.label, rec.name, rec.value, rec.summary, rec.text]) {
        if (typeof field === 'string' && field.toLowerCase().includes(needle)) return true;
      }
    }
  } catch {
    /* ignore snapshot failure during transient unmount */
  }
  return false;
}

function matchesTarget(
  needle: string | null,
  componentKind: string | null,
  agent?: AppAgent,
): boolean {
  if (needle) {
    if (snapshotHasMatch(agent, needle, componentKind)) return true;
    const root = mainRoot();
    if (!componentKind && root && visibleMainText(root).toLowerCase().includes(needle)) return true;
    return false;
  }
  if (componentKind) {
    return snapshotHasMatch(agent, null, componentKind);
  }
  return !hasMainSkeletons();
}

function currentRoute(): string {
  return typeof window !== 'undefined' ? window.location.pathname : '';
}

function makeAbortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Aborted', 'AbortError')
    : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/**
 * Wait on `#main` DOM mutations until a target text/component appears or
 * skeletons clear — wakes up the exact millisecond the target renders without
 * waiting on unrelated background fetches or the global loading bar.
 */
export function waitForMainTarget(options: WaitForTargetOptions = {}): Promise<WaitForTargetResult> {
  const started = Date.now();
  const needle = typeof options.text === 'string' && options.text.trim() ? options.text.trim().toLowerCase() : null;
  const componentKind =
    typeof options.component === 'string' && options.component.trim()
      ? options.component.trim().toLowerCase()
      : null;
  const rawTimeout = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const timeoutMs = Math.min(15_000, Math.max(200, Math.round(rawTimeout)));
  const { signal, agent } = options;

  if (signal?.aborted) return Promise.reject(makeAbortError());

  if (matchesTarget(needle, componentKind, agent)) {
    return Promise.resolve({
      found: true,
      route: currentRoute(),
      waitedMs: 0,
      loading: hasMainSkeletons(),
    });
  }

  return new Promise<WaitForTargetResult>((resolve, reject) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      observer?.disconnect();
      observer = null;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      const loading = hasMainSkeletons();
      resolve({
        found,
        route: currentRoute(),
        waitedMs: Date.now() - started,
        loading,
        ...(found
          ? {}
          : {
              hint: loading
                ? '目标内容尚未渲染完成，主区域仍有骨架屏在加载，可稍后再次 wait_for 或直接操作已可见的控件。'
                : '等待超时，主区域未出现匹配内容，请调用 snapshot 确认当前页面状态。',
            }),
      });
    };

    const check = () => {
      if (settled) return;
      if (matchesTarget(needle, componentKind, agent)) finish(true);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(makeAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const root = mainRoot();
    if (root && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(check);
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'aria-busy', 'aria-label', 'data-agent-hidden'],
      });
    }
    pollTimer = setInterval(check, 250);
    timeoutTimer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Brief DOM-commit settle after a route change inside `act`: resolves as soon
 * as `#main` finishes committing the new page's initial tree (at most 450ms),
 * never blocking on unrelated background network requests.
 */
export function settleRouteCommit(signal?: AbortSignal, maxMs = 450): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted || typeof document === 'undefined') {
      resolve();
      return;
    }
    let settled = false;
    let observer: MutationObserver | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;

    const done = () => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (quietTimer) clearTimeout(quietTimer);
      if (maxTimer) clearTimeout(maxTimer);
      signal?.removeEventListener('abort', done);
      resolve();
    };

    const scheduleQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(done, 60);
    };

    signal?.addEventListener('abort', done, { once: true });
    const root = mainRoot();
    if (root && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(scheduleQuiet);
      observer.observe(root, { subtree: true, childList: true });
    }
    quietTimer = setTimeout(done, 80);
    maxTimer = setTimeout(done, maxMs);
  });
}

/**
 * Wait for an async client-side navigation (Next.js App Router `<Link>` or
 * `router.push`) to update `window.location.pathname`. Exits early on abort or
 * if a new dialog (such as an unsaved-changes leave confirmation) interrupts the
 * transition.
 */
export function waitForRouteChange(
  fromPath: string,
  options: { signal?: AbortSignal; maxMs?: number; expectedPath?: string } = {},
): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  const { signal, maxMs = 4500, expectedPath } = options;
  if (expectedPath && expectedPath === fromPath) return Promise.resolve(false);
  if (window.location.pathname !== fromPath) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);

  const initialDialogs = new Set(
    typeof document !== 'undefined'
      ? Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]'))
      : [],
  );

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (pollTimer) clearInterval(pollTimer);
      if (maxTimer) clearTimeout(maxTimer);
      window.removeEventListener('popstate', check);
      signal?.removeEventListener('abort', onAbort);
      resolve(changed);
    };

    const onAbort = () => finish(false);

    const check = () => {
      if (settled) return;
      if (window.location.pathname !== fromPath) {
        finish(true);
        return;
      }
      if (typeof document !== 'undefined') {
        const dialogs = document.querySelectorAll('[role="alertdialog"], [role="dialog"]');
        for (const dialog of dialogs) {
          if (!initialDialogs.has(dialog) && !dialog.closest('[data-agent-hidden]')) {
            finish(false);
            return;
          }
        }
      }
    };

    window.addEventListener('popstate', check);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true });
    }
    pollTimer = setInterval(check, 25);
    maxTimer = setTimeout(() => finish(window.location.pathname !== fromPath), maxMs);
  });
}

function collectBusySubmitButtons(targets: readonly HTMLElement[]): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  const busy = new Set<HTMLElement>();
  for (const el of targets) {
    if (!el.isConnected || el.closest('[data-agent-hidden]')) continue;
    const btn = el.matches('button') ? el : el.closest<HTMLElement>('button');
    if (btn && btn.getAttribute('aria-busy') === 'true') busy.add(btn);
  }
  if (busy.size === 0 && targets.length > 0) {
    const scopeButtons = document.querySelectorAll<HTMLElement>(
      '[role="dialog"] button[aria-busy="true"], [role="alertdialog"] button[aria-busy="true"], #main button[aria-busy="true"]',
    );
    for (const btn of scopeButtons) {
      if (!btn.closest('[data-agent-hidden]')) busy.add(btn);
    }
  }
  return [...busy];
}

/**
 * When `act` presses an async submit button (which sets `loading={busy}` -> `aria-busy="true"`
 * while its API request is in flight), wait until the button finishes being busy, its host dialog
 * finishes closing/unmounting, the route changes, or a new follow-up confirmation dialog opens.
 * Returns `true` if a busy submission was observed and waited on; returns `false` immediately
 * (0ms) for synchronous buttons.
 */
export async function waitForBusySubmitSettle(options: {
  targets: readonly HTMLElement[];
  signal?: AbortSignal;
  maxMs?: number;
}): Promise<boolean> {
  if (typeof document === 'undefined' || options.signal?.aborted || options.targets.length === 0) {
    return false;
  }
  // Allow one microtask so synchronous setState inside click/submit flushes if pending.
  await Promise.resolve();
  if (options.signal?.aborted) return false;

  const busyButtons = collectBusySubmitButtons(options.targets);
  if (busyButtons.length === 0) return false;

  const { signal, maxMs = 5000 } = options;
  const settleStartPath = typeof window !== 'undefined' ? window.location.pathname : '';
  // Snapshot dialogs AFTER `act` finished (so a dialog opened in step 0 of the same `act` call
  // is not misidentified as a newly spawned confirmation dialog).
  const dialogsAtSettleStart = new Set(
    Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]')),
  );
  const hostDialogs = new Set<Element>();
  for (const btn of busyButtons) {
    const dialog = btn.closest('[role="dialog"], [role="alertdialog"]');
    if (dialog) hostDialogs.add(dialog);
  }

  const isDialogClosing = (dialog: Element) =>
    dialog.isConnected && (dialog.hasAttribute('data-ending-style') || !dialog.hasAttribute('data-open'));

  await new Promise<void>((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let postSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let closeAnimDeadline: number | null = null;

    const cleanup = () => {
      observer?.disconnect();
      observer = null;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (maxTimer) clearTimeout(maxTimer);
      maxTimer = null;
      if (postSettleTimer) clearTimeout(postSettleTimer);
      postSettleTimer = null;
      window.removeEventListener('popstate', check);
      signal?.removeEventListener('abort', finishNow);
    };

    const finishNow = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const hasClosingHostDialog = () => Array.from(hostDialogs).some(isDialogClosing);

    const scheduleBriefCommitSettle = () => {
      if (settled || postSettleTimer !== null) return;
      // Give React / Next.js router a brief commit tick after `setBusy(false)` so
      // `onOpenChange(false)` and `router.push(...)` land before `act` returns.
      postSettleTimer = setTimeout(() => {
        postSettleTimer = null;
        if (settled) return;
        if (hasClosingHostDialog()) {
          // Dialog/Sheet exit animation (`sink` / `slide-out-right`, ~160-200ms) is in progress;
          // wait briefly for it to unmount so `#scroll-root` isolation and `overlaysAfter` settle cleanly.
          closeAnimDeadline = Date.now() + 360;
          check();
          return;
        }
        finishNow();
      }, 80);
    };

    const check = () => {
      if (settled) return;
      const stillBusy = busyButtons.some((btn) => btn.isConnected && btn.getAttribute('aria-busy') === 'true');
      if (!stillBusy && typeof window !== 'undefined' && window.location.pathname !== settleStartPath) {
        finishNow();
        return;
      }
      const dialogs = document.querySelectorAll('[role="alertdialog"], [role="dialog"]');
      for (const dialog of dialogs) {
        if (!dialogsAtSettleStart.has(dialog) && !dialog.closest('[data-agent-hidden]')) {
          finishNow();
          return;
        }
      }
      if (!stillBusy) {
        if (closeAnimDeadline !== null) {
          if (!hasClosingHostDialog() || Date.now() >= closeAnimDeadline) {
            finishNow();
          }
          return;
        }
        if (hasClosingHostDialog()) {
          closeAnimDeadline = Date.now() + 360;
          return;
        }
        scheduleBriefCommitSettle();
      }
    };

    window.addEventListener('popstate', check);
    signal?.addEventListener('abort', finishNow, { once: true });
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(check);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-busy', 'disabled', 'open', 'data-open', 'data-ending-style'],
      });
    }
    pollTimer = setInterval(check, 30);
    maxTimer = setTimeout(finishNow, maxMs);
    check();
  });

  return true;
}
