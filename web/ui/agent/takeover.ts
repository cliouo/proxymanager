'use client';

import { useSyncExternalStore } from 'react';
import type { AgentAction } from '@ui-sdk/react/agent';
import { elementOf } from '@ui-sdk/react/observe';
import { hasPendingAgentConfirm } from './confirm';

export type TakeoverMode = 'idle' | 'standby' | 'acting' | 'paused';
export type TakeoverSource = 'ai_chat' | 'webmcp';
export type PauseReason = 'click' | 'escape' | 'button' | 'popstate';
export type PauseTrigger = 'workspace' | 'assistant';

export interface TakeoverSnapshot {
  mode: TakeoverMode;
  locked: boolean;
  source: TakeoverSource | null;
  activityLabel: string | null;
  inFlightMutation: boolean;
  routeDrifted: boolean;
  pauseReason: PauseReason | null;
  pauseTrigger: PauseTrigger | null;
  confirmPulseSeq: number;
  announcement: string;
}

export interface AgentActionFx {
  id: number;
  kind: 'press' | 'fill';
  rect: { left: number; top: number; width: number; height: number };
  radius: string;
}

// Must stay strictly within @ui-sdk's 5-minute default allow timeout.
export const PAUSE_AUTO_STOP_MS = 4 * 60 * 1000;
const ACTION_FX_DURATION_MS = 520;
const MAX_ACTIVE_FX = 4;

interface PauseWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

const IDLE_SNAPSHOT: TakeoverSnapshot = {
  mode: 'idle',
  locked: false,
  source: null,
  activityLabel: null,
  inFlightMutation: false,
  routeDrifted: false,
  pauseReason: null,
  pauseTrigger: null,
  confirmPulseSeq: 0,
  announcement: '',
};

let snapshot: TakeoverSnapshot = IDLE_SNAPSHOT;
let currentOwner: AbortController | null = null;
let ownerAbortCleanup: (() => void) | null = null;
let onOwnerStop: (() => void) | null = null;
let inFlightActCount = 0;
let inFlightMutatingCount = 0;
let closedQueryCleanupCount = 0;
let releaseAfterCleanup = false;
let webmcpPulseCount = 0;
let webmcpLabel: string | null = null;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let pauseWaiters: PauseWaiter[] = [];
let stopWasTimeout = false;

let nextFxId = 1;
let actionFxList: AgentActionFx[] = [];
const fxTimers = new Map<number, ReturnType<typeof setTimeout>>();

const stateListeners = new Set<() => void>();
const fxListeners = new Set<() => void>();
let trustCheck: (event: Event) => boolean = (event) => event.isTrusted;

export function isTrustedUserEvent(event: Event): boolean {
  return trustCheck(event);
}

export function setTrustCheckForTests(fn: ((event: Event) => boolean) | null): void {
  trustCheck = fn ?? ((event) => event.isTrusted);
}

function makeAbortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Aborted', 'AbortError')
    : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function emitState() {
  for (const listener of stateListeners) listener();
}

function emitFx() {
  for (const listener of fxListeners) listener();
}

function setSnapshot(patch: Partial<TakeoverSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  emitState();
}

function clearPauseTimer() {
  if (pauseTimer !== null) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
}

function settlePauseWaiters(kind: 'resolve' | 'reject') {
  const waiters = pauseWaiters;
  pauseWaiters = [];
  for (const waiter of waiters) {
    waiter.cleanup();
    if (kind === 'resolve') waiter.resolve();
    else waiter.reject(makeAbortError());
  }
}

function detachOwnerAbort() {
  ownerAbortCleanup?.();
  ownerAbortCleanup = null;
}

function finalizeRelease() {
  clearPauseTimer();
  detachOwnerAbort();
  settlePauseWaiters('reject');
  currentOwner = null;
  onOwnerStop = null;
  inFlightActCount = 0;
  inFlightMutatingCount = 0;
  releaseAfterCleanup = false;

  if (webmcpPulseCount > 0) {
    snapshot = {
      ...IDLE_SNAPSHOT,
      mode: 'acting',
      locked: false,
      source: 'webmcp',
      activityLabel: webmcpLabel ?? '外部 agent 正在操作',
      confirmPulseSeq: snapshot.confirmPulseSeq,
    };
  } else {
    snapshot = {
      ...IDLE_SNAPSHOT,
      confirmPulseSeq: snapshot.confirmPulseSeq,
      announcement: snapshot.locked ? 'AI 操作已结束，页面已恢复可操作' : '',
    };
  }
  emitState();
}

function subscribeState(listener: () => void) {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

function subscribeFx(listener: () => void) {
  fxListeners.add(listener);
  return () => {
    fxListeners.delete(listener);
  };
}

export function getTakeoverSnapshot(): TakeoverSnapshot {
  return snapshot;
}

export function useTakeover(): TakeoverSnapshot {
  return useSyncExternalStore(subscribeState, getTakeoverSnapshot, () => IDLE_SNAPSHOT);
}

export function isTakeoverLocked(): boolean {
  return snapshot.locked;
}

export function isWorkspaceBusyForWebMcp(): boolean {
  return currentOwner !== null && !currentOwner.signal.aborted;
}

export function isBuiltinOwnerValid(owner?: AbortController | null): boolean {
  if (!owner) return true;
  if (owner.signal.aborted) return false;
  if (currentOwner && currentOwner !== owner) return false;
  return true;
}

export function acquireTakeover(
  owner: AbortController,
  options: { onStop?: () => void; activityLabel?: string } = {},
): boolean {
  if (owner.signal.aborted) return false;
  if (currentOwner === owner) {
    if (options.onStop) onOwnerStop = options.onStop;
    if (options.activityLabel) setSnapshot({ activityLabel: options.activityLabel });
    return true;
  }
  if (currentOwner && !currentOwner.signal.aborted) return false;

  detachOwnerAbort();
  currentOwner = owner;
  onOwnerStop = options.onStop ?? null;
  releaseAfterCleanup = false;
  stopWasTimeout = false;

  const onAbort = () => {
    clearPauseTimer();
    settlePauseWaiters('reject');
    if (closedQueryCleanupCount > 0) {
      releaseAfterCleanup = true;
      setSnapshot({
        mode: 'standby',
        activityLabel: '正在收尾当前页面查询…',
        inFlightMutation: false,
      });
    } else if (currentOwner === owner) {
      finalizeRelease();
    }
  };
  owner.signal.addEventListener('abort', onAbort, { once: true });
  ownerAbortCleanup = () => owner.signal.removeEventListener('abort', onAbort);

  snapshot = {
    ...IDLE_SNAPSHOT,
    mode: 'standby',
    locked: true,
    source: 'ai_chat',
    activityLabel: options.activityLabel ?? '正在操作页面',
    confirmPulseSeq: snapshot.confirmPulseSeq,
    announcement: 'AI 正在操作页面，按 Esc 或点击页面可暂停',
  };
  emitState();
  return true;
}

export function releaseTakeover(owner: AbortController): void {
  if (currentOwner !== owner) return;
  if (closedQueryCleanupCount > 0) {
    releaseAfterCleanup = true;
    settlePauseWaiters('reject');
    clearPauseTimer();
    setSnapshot({
      mode: 'standby',
      activityLabel: '正在收尾当前页面查询…',
      inFlightMutation: false,
    });
    return;
  }
  finalizeRelease();
}

export function setTakeoverActivity(owner: AbortController | null | undefined, label: string | null): void {
  if (!owner || currentOwner !== owner) return;
  setSnapshot({ activityLabel: label });
}

export function markTakeoverActing(
  owner: AbortController,
  label: string,
  options: { mutating?: boolean } = {},
): () => void {
  if (currentOwner !== owner || owner.signal.aborted) return () => undefined;
  const mutating = options.mutating ?? true;
  inFlightActCount += 1;
  if (mutating) inFlightMutatingCount += 1;

  if (snapshot.mode !== 'paused') {
    setSnapshot({
      mode: 'acting',
      activityLabel: label,
      inFlightMutation: inFlightMutatingCount > 0,
    });
  } else {
    setSnapshot({
      activityLabel: label,
      inFlightMutation: inFlightMutatingCount > 0,
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (currentOwner !== owner) return;
    inFlightActCount = Math.max(0, inFlightActCount - 1);
    if (mutating) inFlightMutatingCount = Math.max(0, inFlightMutatingCount - 1);
    if (snapshot.mode !== 'paused') {
      setSnapshot({
        mode: inFlightActCount > 0 ? 'acting' : 'standby',
        inFlightMutation: inFlightMutatingCount > 0,
      });
    } else {
      setSnapshot({ inFlightMutation: inFlightMutatingCount > 0 });
    }
  };
}

export function beginClosedQueryCleanup(owner: AbortController): () => void {
  closedQueryCleanupCount += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    closedQueryCleanupCount = Math.max(0, closedQueryCleanupCount - 1);
    if (closedQueryCleanupCount === 0 && (releaseAfterCleanup || (currentOwner === owner && owner.signal.aborted))) {
      finalizeRelease();
    }
  };
}

export function beginWebMcpPulse(label = '外部 agent 正在操作'): () => void {
  webmcpPulseCount += 1;
  webmcpLabel = label;
  if (!currentOwner) {
    setSnapshot({
      mode: 'acting',
      locked: false,
      source: 'webmcp',
      activityLabel: label,
    });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    webmcpPulseCount = Math.max(0, webmcpPulseCount - 1);
    if (!currentOwner && webmcpPulseCount === 0) {
      webmcpLabel = null;
      snapshot = {
        ...IDLE_SNAPSHOT,
        confirmPulseSeq: snapshot.confirmPulseSeq,
      };
      emitState();
    }
  };
}

export function pauseTakeover(
  reason: PauseReason,
  trigger: PauseTrigger = 'workspace',
): 'paused' | 'confirm-focused' | 'ignored' {
  if (!currentOwner || currentOwner.signal.aborted || !snapshot.locked) return 'ignored';
  if (hasPendingAgentConfirm()) {
    setSnapshot({ confirmPulseSeq: snapshot.confirmPulseSeq + 1 });
    return 'confirm-focused';
  }
  if (snapshot.mode === 'paused') {
    if (reason === 'popstate' && !snapshot.routeDrifted) {
      setSnapshot({ routeDrifted: true });
    }
    return 'paused';
  }

  clearPauseTimer();
  const pausedOwner = currentOwner;
  pauseTimer = setTimeout(() => {
    pauseTimer = null;
    if (currentOwner === pausedOwner && snapshot.mode === 'paused') {
      stopTakeover('timeout');
    }
  }, PAUSE_AUTO_STOP_MS);

  setSnapshot({
    mode: 'paused',
    pauseReason: reason,
    pauseTrigger: trigger,
    routeDrifted: snapshot.routeDrifted || reason === 'popstate',
    announcement: '已暂停 AI 操作',
  });
  return 'paused';
}

export function resumeTakeover(): void {
  if (!currentOwner || currentOwner.signal.aborted || snapshot.mode !== 'paused') return;
  clearPauseTimer();
  setSnapshot({
    mode: inFlightActCount > 0 ? 'acting' : 'standby',
    pauseReason: null,
    pauseTrigger: null,
    announcement: '已继续让 AI 操作',
  });
  settlePauseWaiters('resolve');
}

export function stopTakeover(reason: 'user' | 'timeout' = 'user'): void {
  if (!currentOwner) return;
  stopWasTimeout = reason === 'timeout';
  clearPauseTimer();
  settlePauseWaiters('reject');
  const stopFn = onOwnerStop;
  const owner = currentOwner;
  if (stopFn) {
    stopFn();
  } else {
    owner.abort();
  }
}

export function consumePauseStopTimeout(): boolean {
  const was = stopWasTimeout;
  stopWasTimeout = false;
  return was;
}

export function markTakeoverRouteDrifted(): void {
  if (!snapshot.locked || !currentOwner || currentOwner.signal.aborted) return;
  clearAgentActionFx();
  if (snapshot.mode === 'paused') {
    if (!snapshot.routeDrifted) setSnapshot({ routeDrifted: true });
    return;
  }
  pauseTakeover('popstate', 'workspace');
}

export function consumeTakeoverRouteDrifted(): boolean {
  if (!snapshot.routeDrifted) return false;
  setSnapshot({ routeDrifted: false });
  return true;
}

export function waitIfPaused(signal?: AbortSignal, owner?: AbortController | null): Promise<void> {
  if (signal?.aborted || owner?.signal.aborted) return Promise.reject(makeAbortError());
  if (owner && currentOwner && currentOwner !== owner) return Promise.reject(makeAbortError());
  if (snapshot.mode !== 'paused') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      pauseWaiters = pauseWaiters.filter((entry) => entry !== waiter);
      waiter.cleanup();
      reject(makeAbortError());
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (owner && owner.signal !== signal) {
        owner.signal.removeEventListener('abort', onAbort);
      }
    };
    const waiter: PauseWaiter = { resolve, reject, cleanup };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (owner && owner.signal !== signal) {
      owner.signal.addEventListener('abort', onAbort, { once: true });
    }
    pauseWaiters = [...pauseWaiters, waiter];
  });
}

function accessibleName(el: Element): string {
  return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
}

export function resolveActionTargetElement(step: AgentAction): HTMLElement | null {
  if (typeof document === 'undefined' || step.component === 'tool') return null;
  let root: Element | null = null;
  try {
    root = elementOf(step.ref);
  } catch {
    root = null;
  }
  if (!(root instanceof HTMLElement) || !root.isConnected) return null;

  const isPress = step.action === 'press' || step.action === 'click';
  const targetText =
    (isPress || step.component === 'tabs') && typeof step.args[0] === 'string' ? step.args[0].trim() : '';
  if (targetText) {
    const candidates = root.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="option"]',
    );
    const exact = [...candidates].find((el) => !el.closest('[data-agent-hidden]') && accessibleName(el) === targetText);
    if (exact) return exact;
    const lower = targetText.toLowerCase();
    const partial = [...candidates].find(
      (el) => !el.closest('[data-agent-hidden]') && accessibleName(el).toLowerCase().includes(lower),
    );
    if (partial) return partial;
  }
  if (step.component === 'tabs') {
    const tablist = root.querySelector<HTMLElement>('[role="tablist"]');
    if (tablist) return tablist;
  }
  return root;
}

export function emitElementActionFx(el: HTMLElement | null, kind: 'press' | 'fill'): void {
  if (!el || !el.isConnected || typeof window === 'undefined') return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  // Skip large section/container roots (e.g. Tabs/Accordion wrappers) so stray highlights never bisect page content.
  if (rect.height > 160 && rect.width > 360) return;
  if (kind === 'fill' && rect.height > 120) return;
  // Skip off-viewport targets rather than drawing floating boxes outside the screen.
  if (
    rect.bottom <= 0 ||
    rect.top >= window.innerHeight ||
    rect.right <= 0 ||
    rect.left >= window.innerWidth
  ) {
    return;
  }
  const radius = window.getComputedStyle(el).borderRadius || '8px';
  emitAgentActionFx({
    kind,
    rect: {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.left)),
      height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.top)),
    },
    radius,
  });
}

export function emitAgentActionFx(fx: Omit<AgentActionFx, 'id'>): void {
  const id = nextFxId++;
  const next: AgentActionFx = { ...fx, id };
  actionFxList = [...actionFxList.slice(-(MAX_ACTIVE_FX - 1)), next];
  emitFx();

  const timer = setTimeout(() => {
    fxTimers.delete(id);
    actionFxList = actionFxList.filter((item) => item.id !== id);
    emitFx();
  }, ACTION_FX_DURATION_MS);
  fxTimers.set(id, timer);
}

export function clearAgentActionFx(): void {
  for (const timer of fxTimers.values()) clearTimeout(timer);
  fxTimers.clear();
  if (actionFxList.length > 0) {
    actionFxList = [];
    emitFx();
  }
}

export function useAgentActionFx(): AgentActionFx[] {
  return useSyncExternalStore(subscribeFx, () => actionFxList, () => []);
}

export function resetTakeoverForTests(): void {
  trustCheck = (event) => event.isTrusted;
  clearAgentActionFx();
  closedQueryCleanupCount = 0;
  webmcpPulseCount = 0;
  webmcpLabel = null;
  stopWasTimeout = false;
  finalizeRelease();
  snapshot = IDLE_SNAPSHOT;
  emitState();
}
