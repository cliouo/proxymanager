'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play, ShieldAlert, Square } from 'lucide-react';
import { cn } from '@/ui/lib/cn';
import { useUi } from '@/ui/shell/state';
import { usePendingAgentConfirm } from './confirm';
import {
  clearAgentActionFx,
  getTakeoverSnapshot,
  isTakeoverLocked,
  isTrustedUserEvent,
  markTakeoverRouteDrifted,
  pauseTakeover,
  resumeTakeover,
  stopTakeover,
  useAgentActionFx,
  useTakeover,
} from './takeover';

const EXEMPT_SELECTOR = '[data-takeover-exempt]';
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

function isExemptEvent(event: Event): boolean {
  if (typeof event.composedPath === 'function') {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.matches(EXEMPT_SELECTOR)) return true;
    }
  }
  return event.target instanceof Element && Boolean(event.target.closest(EXEMPT_SELECTOR));
}

function isScrollableFocusTarget(target: EventTarget | null): boolean {
  if (!target || target === window || target === document) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target === document.body || target === document.documentElement) return true;
  const tag = target.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return false;
  }
  const role = target.getAttribute('role');
  if (role && role !== 'region' && role !== 'main') return false;
  const style = window.getComputedStyle(target);
  return /(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflowX);
}

function focusTakeoverEscapeHatch() {
  const barAction = document.querySelector<HTMLElement>('[data-takeover-bar] button');
  if (barAction) {
    barAction.focus();
    return;
  }
  const assistantInput = document.querySelector<HTMLElement>('[data-assistant-panel] textarea, [data-assistant-panel] button');
  assistantInput?.focus();
}

export function AgentTakeoverGuard() {
  const takeover = useTakeover();

  useEffect(() => {
    const root = document.documentElement;
    if (takeover.locked) {
      root.setAttribute('data-agent-locked', 'true');
      root.setAttribute('data-agent-takeover', takeover.mode);
    } else {
      root.removeAttribute('data-agent-locked');
      if (takeover.mode !== 'idle') root.setAttribute('data-agent-takeover', takeover.mode);
      else root.removeAttribute('data-agent-takeover');
    }
    return () => {
      root.removeAttribute('data-agent-locked');
      root.removeAttribute('data-agent-takeover');
    };
  }, [takeover.locked, takeover.mode]);

  useEffect(() => {
    // Register once on startup so our capture handlers precede late-registered capture listeners.
    const suppressedPointers = new Set<number>();
    let suppressNextClick = false;
    let suppressClickTimer: ReturnType<typeof setTimeout> | null = null;

    const armTrailingClickSuppression = () => {
      suppressNextClick = true;
      if (suppressClickTimer !== null) clearTimeout(suppressClickTimer);
      suppressClickTimer = setTimeout(() => {
        suppressNextClick = false;
        suppressClickTimer = null;
      }, 400);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!isTrustedUserEvent(event) || !isTakeoverLocked()) return;
      if (isExemptEvent(event)) return;

      if (event.pointerType === 'touch') {
        // Isolate business sensors on touchstart/pointerdown while keeping native scroll intact; tap pauses on click.
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      suppressedPointers.add(event.pointerId);
      armTrailingClickSuppression();
      pauseTakeover('click', 'workspace');
    };

    const onPointerUpOrCancel = (event: PointerEvent) => {
      if (!isTrustedUserEvent(event)) return;
      if (suppressedPointers.has(event.pointerId)) {
        suppressedPointers.delete(event.pointerId);
        // Always swallow the trailing pointerup of an already-suppressed gesture, even if Pause Bar appeared underneath.
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!isTakeoverLocked() || isExemptEvent(event)) return;
      if (event.pointerType === 'touch') {
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onTouchBoundary = (event: TouchEvent) => {
      if (!isTrustedUserEvent(event) || !isTakeoverLocked()) return;
      if (isExemptEvent(event)) return;
      // Do not preventDefault so touch scrolling and pinch-zoom remain native; stopPropagation isolates dnd TouchSensor.
      event.stopImmediatePropagation();
    };

    const onClick = (event: MouseEvent) => {
      if (!isTrustedUserEvent(event)) return;
      if (suppressNextClick) {
        suppressNextClick = false;
        if (suppressClickTimer !== null) {
          clearTimeout(suppressClickTimer);
          suppressClickTimer = null;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!isTakeoverLocked() || isExemptEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pauseTakeover('click', 'workspace');
    };

    const onBlockedMouseOrDrag = (event: Event) => {
      if (!isTrustedUserEvent(event) || !isTakeoverLocked()) return;
      if (isExemptEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'auxclick' || event.type === 'contextmenu') {
        pauseTakeover('click', 'workspace');
      }
    };

    const onBlockedMutationInput = (event: Event) => {
      if (!isTrustedUserEvent(event) || !isTakeoverLocked()) return;
      if (isExemptEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTrustedUserEvent(event) || event.isComposing || !isTakeoverLocked()) return;
      const inExempt = isExemptEvent(event);

      if (event.key === 'Escape') {
        const snap = getTakeoverSnapshot();
        // Single-direction pause only: never un-pause on Esc (prevents key-repeat toggle).
        if (snap.mode === 'standby' || snap.mode === 'acting') {
          const inDialog =
            event.target instanceof Element &&
            Boolean(event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'));
          if (inExempt && inDialog) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          pauseTakeover('escape', inExempt ? 'assistant' : 'workspace');
        }
        return;
      }

      if (inExempt) return;

      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        focusTakeoverEscapeHatch();
        return;
      }

      if (SCROLL_KEYS.has(event.key) && isScrollableFocusTarget(event.target)) {
        return;
      }

      // Silently eat stray keys on the left so focus stolen by an AI-opened dialog never causes false pause.
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onPopState = () => {
      if (!isTakeoverLocked()) return;
      markTakeoverRouteDrifted();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUpOrCancel, true);
    window.addEventListener('pointercancel', onPointerUpOrCancel, true);
    window.addEventListener('touchstart', onTouchBoundary, { capture: true, passive: true });
    window.addEventListener('touchend', onTouchBoundary, { capture: true, passive: true });
    window.addEventListener('click', onClick, true);
    window.addEventListener('dblclick', onBlockedMouseOrDrag, true);
    window.addEventListener('auxclick', onBlockedMouseOrDrag, true);
    window.addEventListener('contextmenu', onBlockedMouseOrDrag, true);
    window.addEventListener('dragstart', onBlockedMouseOrDrag, true);
    window.addEventListener('dragover', onBlockedMouseOrDrag, true);
    window.addEventListener('drop', onBlockedMouseOrDrag, true);
    window.addEventListener('beforeinput', onBlockedMutationInput, true);
    window.addEventListener('paste', onBlockedMutationInput, true);
    window.addEventListener('submit', onBlockedMutationInput, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('popstate', onPopState);

    return () => {
      if (suppressClickTimer !== null) clearTimeout(suppressClickTimer);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUpOrCancel, true);
      window.removeEventListener('pointercancel', onPointerUpOrCancel, true);
      window.removeEventListener('touchstart', onTouchBoundary, true);
      window.removeEventListener('touchend', onTouchBoundary, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('dblclick', onBlockedMouseOrDrag, true);
      window.removeEventListener('auxclick', onBlockedMouseOrDrag, true);
      window.removeEventListener('contextmenu', onBlockedMouseOrDrag, true);
      window.removeEventListener('dragstart', onBlockedMouseOrDrag, true);
      window.removeEventListener('dragover', onBlockedMouseOrDrag, true);
      window.removeEventListener('drop', onBlockedMouseOrDrag, true);
      window.removeEventListener('beforeinput', onBlockedMutationInput, true);
      window.removeEventListener('paste', onBlockedMutationInput, true);
      window.removeEventListener('submit', onBlockedMutationInput, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  return null;
}

interface WorkspaceRect {
  width: number;
  height: number;
}

function measureLeftWorkspaceRect(): WorkspaceRect {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const panel = document.querySelector<HTMLElement>('[data-assistant-panel]');
  if (!panel) return { width: Math.round(vw), height: Math.round(vh) };
  const box = panel.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return { width: Math.round(vw), height: Math.round(vh) };
  // Leave a crisp boundary stopping right before the visible assistant panel.
  const leftWidth = Math.max(0, Math.min(Math.round(vw), Math.round(box.left)));
  return { width: leftWidth, height: Math.round(vh) };
}

function useLeftWorkspaceRect(active: boolean): WorkspaceRect {
  const assistantOpen = useUi((s) => s.assistantOpen);
  const assistantDocked = useUi((s) => s.assistantDocked);
  const [rect, setRect] = useState<WorkspaceRect>(() => measureLeftWorkspaceRect());

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = measureLeftWorkspaceRect();
        setRect((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
      });
    };
    sync();

    let ro: ResizeObserver | null = null;
    const panel = document.querySelector<HTMLElement>('[data-assistant-panel]');
    if (panel && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(sync);
      ro.observe(panel);
    }

    // Track assistant dock spring transitions for 500ms after open/close changes.
    const settleTimer = setTimeout(sync, 480);
    window.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('resize', sync);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      ro?.disconnect();
      window.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('resize', sync);
    };
  }, [active, assistantOpen, assistantDocked]);

  return rect;
}

export function AgentTakeoverAura() {
  const takeover = useTakeover();
  const pendingConfirm = usePendingAgentConfirm();
  const active = takeover.mode !== 'idle';
  const rect = useLeftWorkspaceRect(active);

  if (!active || rect.width < 48 || rect.height < 48) return null;

  const waitingForHuman = takeover.mode === 'paused' || Boolean(pendingConfirm);
  const acting = !waitingForHuman && takeover.mode === 'acting';
  const stateAttr = waitingForHuman ? 'paused' : acting ? 'acting' : 'standby';

  return (
    <div
      aria-hidden="true"
      data-agent-hidden
      data-takeover-exempt
      data-aura-state={stateAttr}
      style={{ width: rect.width, height: rect.height }}
      className="agent-fluid-aura pointer-events-none fixed left-0 top-0 z-[58] overflow-hidden"
    >
      {/* Soft feathered edge mist so the perimeter never reads as a rigid hairline or sharp 90deg corner. */}
      <div className="agent-aura-mist" />
      <div className="agent-aura-vignette" />
      {/* Independent non-harmonic radial waves gliding around the edges like luminous air and water. */}
      <span className="agent-aura-wave agent-aura-wave-top" />
      <span className="agent-aura-wave agent-aura-wave-right" />
      <span className="agent-aura-wave agent-aura-wave-bottom" />
      <span className="agent-aura-wave agent-aura-wave-left" />
      <span className="agent-aura-wave agent-aura-wave-corner" />
    </div>
  );
}

export function AgentTakeoverBar() {
  const takeover = useTakeover();
  const pendingConfirm = usePendingAgentConfirm();
  const active = takeover.mode !== 'idle';
  const rect = useLeftWorkspaceRect(active);
  const resumeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (takeover.mode === 'paused' && takeover.pauseTrigger === 'workspace') {
      const frame = requestAnimationFrame(() => resumeRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [takeover.mode, takeover.pauseTrigger]);

  // Keep a stable host mounted in the DOM so @ui-sdk persistentElements always resolves [data-takeover-bar].
  const showVisual = active && rect.width >= 260;
  const centerX = Math.round(rect.width / 2);

  return (
    <div
      data-takeover-bar
      data-agent-hidden
      data-takeover-exempt
      className="pointer-events-none fixed inset-0 z-[59]"
    >
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {takeover.announcement}
      </div>

      {showVisual && (
        <div
          style={{
            left: centerX,
            maxWidth: Math.max(240, rect.width - 24),
            bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          }}
          className="pointer-events-auto fixed -translate-x-1/2"
        >
          {takeover.mode === 'paused' ? (
            <div
              role="region"
              aria-label="AI 操作已暂停"
              className="animate-pop flex w-[min(430px,calc(100vw-32px))] max-w-full flex-col gap-2.5 rounded-2xl border border-warn/40 bg-surface/96 px-4 py-3 text-ink shadow-xl backdrop-blur-md"
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-warn-soft text-warn">
                  <ShieldAlert size={14} strokeWidth={2} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-ink">
                    {takeover.routeDrifted
                      ? '页面已切换，已暂停 AI 操作'
                      : takeover.inFlightMutation
                        ? '已暂停后续操作'
                        : '已暂停 AI 操作'}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
                    {takeover.routeDrifted
                      ? '继续前将重新读取当前页面，避免按旧位置误操作；已完成步骤不会撤销。'
                      : takeover.inFlightMutation
                        ? '思考继续，但不再发起新操作。当前正在提交的请求可能仍会完成，已完成步骤不会撤销。'
                        : `${takeover.activityLabel ? `当前阶段：${takeover.activityLabel.replace(/[…。.]+$/, '')}。` : ''}思考继续，页面操作已暂停；已完成步骤不会撤销。`}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => stopTakeover('user')}
                  className="inline-flex h-8 select-none items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                  停止 AI，由我操作
                </button>
                <button
                  ref={resumeRef}
                  type="button"
                  onClick={() => resumeTakeover()}
                  className="inline-flex h-8 select-none items-center gap-1.5 rounded-lg bg-inverse px-3 text-xs font-medium text-inverse-ink shadow-xs transition hover:bg-inverse/88 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Play size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                  继续让 AI 操作
                </button>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                'animate-pop flex items-center gap-2.5 rounded-full border bg-surface/94 py-1.5 pl-3 pr-2 text-xs text-ink shadow-lg backdrop-blur-md',
                pendingConfirm ? 'border-warn/45' : 'border-accent-line/75',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  pendingConfirm
                    ? 'bg-warn'
                    : takeover.mode === 'acting'
                      ? 'bg-accent animate-pulse'
                      : 'bg-accent/65',
                )}
              />
              <span className="max-w-[260px] truncate font-medium text-ink">
                {pendingConfirm
                  ? '等待你在右侧确认操作'
                  : takeover.source === 'webmcp'
                    ? takeover.activityLabel || '外部 agent 正在操作'
                    : takeover.activityLabel
                      ? `AI 正在操作 · ${takeover.activityLabel}`
                      : 'AI 正在操作页面'}
              </span>
              {takeover.locked && !pendingConfirm && (
                <button
                  type="button"
                  onClick={() => pauseTakeover('button', 'workspace')}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 text-2xs font-medium text-ink-2 transition hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Pause size={10} strokeWidth={2.2} aria-hidden="true" />
                  暂停
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentActionStage() {
  const items = useAgentActionFx();

  useEffect(() => {
    const onPop = () => clearAgentActionFx();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!items.length) return null;

  return (
    <div
      aria-hidden="true"
      data-agent-hidden
      data-takeover-exempt
      className="pointer-events-none fixed inset-0 z-[59] overflow-hidden"
    >
      {items.map((item) => (
        <div
          key={item.id}
          style={{
            left: item.rect.left,
            top: item.rect.top,
            width: item.rect.width,
            height: item.rect.height,
            borderRadius: item.radius,
          }}
          className={cn(
            'fixed',
            item.kind === 'press' ? 'agent-fx-press' : 'agent-fx-fill',
          )}
        >
          {item.kind === 'press' && (
            <span
              className="agent-fx-ring absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full"
            />
          )}
          {item.kind === 'fill' && (
            <span className="agent-fx-underline absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-accent" />
          )}
        </div>
      ))}
    </div>
  );
}
