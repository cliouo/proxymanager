'use client';

import { useSyncExternalStore } from 'react';
import type { AgentComponent, AppAgent, ObservedChange } from '@/ui/agent';

export type ToolErrorCode =
  | 'component_missing'
  | 'label_ambiguous'
  | 'option_as_component'
  | 'overlay_closed'
  | 'invalid_args'
  | 'user_rejected'
  | 'unknown';

export const TOOL_ERROR_LABELS: Record<ToolErrorCode, string> = {
  component_missing: '组件缺失',
  label_ambiguous: '标签歧义',
  option_as_component: '把选项当组件',
  overlay_closed: '观察到弹层关闭',
  invalid_args: '参数格式',
  user_rejected: '用户拒绝或中断',
  unknown: '未知',
};

export interface ToolErrorAnalysis {
  code: ToolErrorCode;
  codes: ToolErrorCode[];
  hint?: string;
  failedStepIndex?: number;
  completedSteps?: number;
}

export type FocusRegion = 'assistant' | 'takeover_bar' | 'overlay' | 'sidebar' | 'main' | 'other' | 'none';

export interface OverlayStateSummary {
  ref: string;
  component: string;
  label?: string;
  open: boolean;
  buttonCount?: number;
  itemCount?: number;
}

export interface OverlayTransitionEvent {
  tsOffsetMs: number;
  ref: string;
  component: string;
  label?: string;
  open: boolean;
  reason?: string;
  source?: string;
}

export interface ToolCallDiagnostic {
  round: number;
  slot: string;
  tool: string;
  status: 'ok' | 'error';
  tsOffsetMs: number;
  durationMs: number;
  routeBefore: string;
  routeAfter: string;
  focusBefore: FocusRegion;
  focusAfter: FocusRegion;
  stepCount?: number;
  completedSteps?: number;
  failedStepIndex?: number;
  targetRefs?: string[];
  actions?: string[];
  errorCode?: ToolErrorCode;
  errorCodes?: ToolErrorCode[];
  navigated?: boolean;
  navigationPending?: boolean;
  overlaysBefore: OverlayStateSummary[];
  overlaysAfter: OverlayStateSummary[];
  closedSincePrevCall?: Array<{ ref: string; component: string; label?: string }>;
  closedBeforeReturn?: Array<{ ref: string; component: string; label?: string }>;
}

interface DiagnosticRunState {
  id: string;
  startedAt: string;
  startedMs: number;
  model: string;
  initialRoute: string;
  calls: ToolCallDiagnostic[];
  overlayTransitions: OverlayTransitionEvent[];
  lastObservedSnapshot: AgentComponent[];
  lastOpenOverlays: OverlayStateSummary[];
  recentClosedOverlays: OverlayTransitionEvent[];
}

const MAX_CALL_RECORDS = 40;
const MAX_OVERLAY_EVENTS = 60;
const OVERLAY_KINDS = new Set(['popover', 'menu', 'dialog', 'alertdialog', 'combobox', 'select', 'command']);
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function scrubRouteTemplate(pathname: string): string {
  if (!pathname) return '/';
  const raw = pathname.split(/[?#]/)[0] || '/';
  const segments = raw.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prev = segments[i - 1];
    if (prev === 'p') {
      out.push(':profile');
    } else if (prev === 'groups' || prev === 'devices' || prev === 'sources' || prev === 'pools') {
      out.push(':id');
    } else if (UUID_SEGMENT_RE.test(seg)) {
      out.push(':id');
    } else {
      out.push(seg);
    }
  }
  return `/${out.join('/')}`;
}

export function captureFocusRegion(): FocusRegion {
  if (typeof document === 'undefined') return 'none';
  const el = document.activeElement;
  if (!(el instanceof Element) || el === document.body || el === document.documentElement) return 'none';
  if (el.closest('[data-assistant-panel], [data-assistant-surface], [data-agent-confirm-card]')) return 'assistant';
  if (el.closest('[data-takeover-bar]')) return 'takeover_bar';
  if (el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]')) {
    return 'overlay';
  }
  if (el.closest('[data-takeover-sidebar], nav[aria-label="主导航"]')) return 'sidebar';
  if (el.closest('#main')) return 'main';
  return 'other';
}

export function extractOpenOverlays(items: AgentComponent[]): OverlayStateSummary[] {
  const out: OverlayStateSummary[] = [];
  for (const item of items) {
    if (item.offPage || item.component === 'more') continue;
    const isOverlay = OVERLAY_KINDS.has(item.component) || typeof item.open === 'boolean';
    if (!isOverlay) continue;
    if (item.open !== true && item.component !== 'command') continue;
    out.push({
      ref: item.ref,
      component: item.component,
      label: item.label,
      open: item.open === true || item.component === 'command',
      ...(Array.isArray(item.buttons) ? { buttonCount: item.buttons.length } : {}),
      ...(Array.isArray(item.items) ? { itemCount: item.items.length } : {}),
    });
  }
  return out;
}

export function extractMountedOpenOverlays(agent: AppAgent): OverlayStateSummary[] {
  try {
    return extractOpenOverlays(agent.snapshot());
  } catch {
    return [];
  }
}

function safeSnapshot(agent: AppAgent): AgentComponent[] {
  try {
    return agent.snapshot();
  } catch {
    return [];
  }
}

function normalizeMatchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface OptionSuggestion {
  parentLabel: string;
  parentComponent: string;
  action: 'press' | 'run' | 'setValue';
  argValue: string;
  displayLabel: string;
  multiSelect?: boolean;
}

function findUniqueOptionMatches(wanted: string, components: AgentComponent[]): OptionSuggestion[] {
  const wantedNorm = normalizeMatchText(wanted);
  if (!wantedNorm) return [];
  const matches: OptionSuggestion[] = [];

  for (const item of components) {
    if (item.offPage || item.component === 'more') continue;
    const parentLabel = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : null;
    if (!parentLabel) continue;
    const actions = Array.isArray(item.actions) ? item.actions : [];

    // 1. Check buttons (menu, dialog, alertdialog, toast, popover)
    if (Array.isArray(item.buttons) && actions.includes('press')) {
      const btnMatches = item.buttons.filter(
        (b): b is string => typeof b === 'string' && normalizeMatchText(b) === wantedNorm,
      );
      if (btnMatches.length === 1) {
        matches.push({
          parentLabel,
          parentComponent: item.component,
          action: 'press',
          argValue: btnMatches[0],
          displayLabel: btnMatches[0],
        });
      }
    }

    // 2. Check items (command -> run, select/combobox/tabs/radio-group -> setValue)
    if (Array.isArray(item.items)) {
      const preferredAction =
        item.component === 'command' && actions.includes('run')
          ? 'run'
          : actions.includes('setValue')
            ? 'setValue'
            : null;
      if (!preferredAction) continue;
      const itemMatches = item.items.filter((opt) => {
        if (!opt || typeof opt.value !== 'string') return false;
        const valNorm = normalizeMatchText(opt.value);
        const lblNorm = typeof opt.label === 'string' ? normalizeMatchText(opt.label) : '';
        return valNorm === wantedNorm || lblNorm === wantedNorm || (lblNorm && lblNorm.includes(wantedNorm));
      });
      if (itemMatches.length === 1) {
        const picked = itemMatches[0];
        matches.push({
          parentLabel,
          parentComponent: item.component,
          action: preferredAction,
          argValue: picked.value,
          displayLabel: picked.label || picked.value,
          multiSelect: preferredAction === 'setValue' && Array.isArray(item.value),
        });
      }
    }
  }
  return matches;
}

export function analyzeToolError(options: {
  name: string;
  input?: unknown;
  data: unknown;
  currentSnapshot: AgentComponent[];
  lastObservedSnapshot?: AgentComponent[];
  recentClosedOverlays?: Array<{ ref: string; component: string; label?: string }>;
}): ToolErrorAnalysis {
  const { input, data, currentSnapshot, lastObservedSnapshot = [], recentClosedOverlays = [] } = options;
  const rec = isRecord(data) ? data : null;
  const nestedErr = rec && isRecord(rec.error) ? rec.error : null;
  const message =
    typeof rec?.error === 'string'
      ? rec.error
      : typeof nestedErr?.message === 'string'
        ? nestedErr.message
        : '';
  const failedStepIndex = typeof nestedErr?.step === 'number' ? nestedErr.step : undefined;
  const completedSteps = Array.isArray(rec?.steps) ? rec.steps.length : undefined;
  const failedStep =
    failedStepIndex !== undefined && isRecord(input) && Array.isArray(input.steps) && isRecord(input.steps[failedStepIndex])
      ? (input.steps[failedStepIndex] as Record<string, unknown>)
      : null;
  const codes: ToolErrorCode[] = [];
  const pushCode = (code: ToolErrorCode) => {
    if (!codes.includes(code)) codes.push(code);
  };

  if (
    rec?.interrupted === true ||
    rec?.status === 'dispatched_unverified' ||
    /Needs a person|用户拒绝|调用被中断|被拒绝|已取消/.test(message)
  ) {
    pushCode('user_rejected');
    return { code: 'user_rejected', codes, failedStepIndex, completedSteps };
  }

  if (/合法的 JSON|Invalid|must be an array|Unknown action|missing required/i.test(message)) {
    pushCode('invalid_args');
    return { code: 'invalid_args', codes, failedStepIndex, completedSteps };
  }

  const ambigMatch = message.match(/^"([^"]+)" names (\d+) components:/);
  if (ambigMatch) {
    pushCode('label_ambiguous');
    return {
      code: 'label_ambiguous',
      codes,
      failedStepIndex,
      completedSteps,
      hint: `「${ambigMatch[1]}」在当前页面对应多个同名控件，请先根据上下文确认目标，再用报错列出的精确 ref 调用。`,
    };
  }

  // Case A: ui-sdk matched the option text to a parent command/select/combobox/tabs and rejected `press`.
  const wrongPressMatch = message.match(/^([a-z-]+)\s+(c\d+)\s+(?:has nothing to press|has no action)/i);
  if (wrongPressMatch) {
    const [, , matchedRef] = wrongPressMatch;
    const failedRef = typeof failedStep?.ref === 'string' ? failedStep.ref.trim() : '';
    const failedArg =
      Array.isArray(failedStep?.args) && typeof failedStep.args[0] === 'string' ? failedStep.args[0].trim() : '';
    const parentComp = currentSnapshot.find((c) => c.ref === matchedRef);
    const wanted = failedArg || failedRef;
    if (parentComp && wanted) {
      const optionMatches = findUniqueOptionMatches(wanted, [parentComp]);
      if (optionMatches.length === 1) {
        const m = optionMatches[0];
        pushCode('option_as_component');
        const hint = m.multiSelect
          ? `「${m.displayLabel}」是「${m.parentLabel}」（${m.parentComponent}）内的多选项，请先读取已选值再调用 setValue 传入完整数组。`
          : `「${m.displayLabel}」是「${m.parentLabel}」（${m.parentComponent}）内部的选项，不能用 press；请改为：${JSON.stringify({
              ref: m.parentLabel,
              action: m.action,
              args: [m.argValue],
            })}`;
        return { code: 'option_as_component', codes, hint, failedStepIndex, completedSteps };
      }
    }
    pushCode('invalid_args');
    return { code: 'invalid_args', codes, failedStepIndex, completedSteps };
  }

  const missingMatch =
    message.match(/^No component "([^"]+)" on the page/) ??
    message.match(/^No "([^"]+)" in a section/);
  if (missingMatch) {
    const wanted = missingMatch[1].trim();
    const mountedMatches = findUniqueOptionMatches(wanted, currentSnapshot);
    if (mountedMatches.length === 1) {
      const m = mountedMatches[0];
      pushCode('option_as_component');
      const hint = m.multiSelect
        ? `「${m.displayLabel}」是「${m.parentLabel}」（${m.parentComponent}）内的多选项，不是独立组件；请先读取当前已选值，再向「${m.parentLabel}」调用 setValue 传入完整数组。`
        : `「${m.displayLabel}」是「${m.parentLabel}」（${m.parentComponent}）内部的选项，不是独立组件；请改为单步调用：${JSON.stringify({
            ref: m.parentLabel,
            action: m.action,
            args: [m.argValue],
          })}`;
      return { code: 'option_as_component', codes, hint, failedStepIndex, completedSteps };
    }

    // Check if the missing component or its parent overlay was open in the previous turn and closed before this call.
    const wantedNorm = normalizeMatchText(wanted);
    const wasInPreviousSnapshot = lastObservedSnapshot.some(
      (c) =>
        !c.offPage &&
        ((typeof c.label === 'string' && normalizeMatchText(c.label) === wantedNorm) || c.ref === wanted),
    );
    const closedMatch = recentClosedOverlays.find(
      (o) => (typeof o.label === 'string' && normalizeMatchText(o.label) === wantedNorm) || o.ref === wanted,
    );
    const prevOptionMatches = findUniqueOptionMatches(wanted, lastObservedSnapshot);

    if (wasInPreviousSnapshot || closedMatch || recentClosedOverlays.length > 0) {
      if (wasInPreviousSnapshot || closedMatch) {
        pushCode('overlay_closed');
      }
      if (prevOptionMatches.length === 1) {
        pushCode('option_as_component');
        pushCode('overlay_closed');
        const m = prevOptionMatches[0];
        return {
          code: 'overlay_closed',
          codes,
          failedStepIndex,
          completedSteps,
          hint: `「${m.parentLabel}」（${m.parentComponent}）当前已关闭，且「${m.displayLabel}」是其内部选项；请先重新打开或调用 snapshot 确认当前界面，再用 ${m.action} 传入目标 value。`,
        };
      }
      if (wasInPreviousSnapshot || closedMatch) {
        return {
          code: 'overlay_closed',
          codes,
          failedStepIndex,
          completedSteps,
          hint: `「${wanted}」在上一轮曾出现，但对应浮层现已关闭；请先重新打开该浮层或调用 snapshot 核对当前可用控件。`,
        };
      }
    }

    pushCode('component_missing');
    return { code: 'component_missing', codes, failedStepIndex, completedSteps };
  }

  pushCode('unknown');
  return { code: 'unknown', codes, failedStepIndex, completedSteps };
}

export class RunDiagnosticRecorder {
  private readonly state: DiagnosticRunState;
  private unsubscribe: (() => void) | null = null;

  constructor(options: { model: string; initialRoute: string; agent?: AppAgent }) {
    this.state = {
      id: `run_${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      model: options.model,
      initialRoute: scrubRouteTemplate(options.initialRoute),
      calls: [],
      overlayTransitions: [],
      lastObservedSnapshot: [],
      lastOpenOverlays: [],
      recentClosedOverlays: [],
    };
    if (options.agent && typeof options.agent.subscribe === 'function') {
      try {
        this.unsubscribe = options.agent.subscribe((change: ObservedChange) => {
          this.onObservedChange(change);
        });
      } catch {
        this.unsubscribe = null;
      }
    }
  }

  private onObservedChange(change: ObservedChange) {
    if (change.key !== 'open' || typeof change.value !== 'boolean') return;
    const entry: OverlayTransitionEvent = {
      tsOffsetMs: Math.max(0, Date.now() - this.state.startedMs),
      ref: change.ref,
      component: change.component,
      label: change.label,
      open: change.value,
      reason: change.reason,
      source: change.source,
    };
    this.state.overlayTransitions.push(entry);
    if (this.state.overlayTransitions.length > MAX_OVERLAY_EVENTS) {
      this.state.overlayTransitions.shift();
    }
    if (change.value === false) {
      this.state.recentClosedOverlays.push(entry);
      if (this.state.recentClosedOverlays.length > 10) {
        this.state.recentClosedOverlays.shift();
      }
    }
  }

  getLastObservedSnapshot(): AgentComponent[] {
    return this.state.lastObservedSnapshot;
  }

  getRecentClosedOverlays(): Array<{ ref: string; component: string; label?: string }> {
    return this.state.recentClosedOverlays;
  }

  beginCall(agent: AppAgent) {
    const startedMs = Date.now();
    const routeBefore =
      typeof window !== 'undefined' ? scrubRouteTemplate(window.location.pathname) : this.state.initialRoute;
    const focusBefore = captureFocusRegion();
    const overlaysBefore = extractMountedOpenOverlays(agent);
    const beforeRefs = new Set(overlaysBefore.map((o) => o.ref));
    const closedSincePrevCall = this.state.lastOpenOverlays
      .filter((prev) => !beforeRefs.has(prev.ref))
      .map(({ ref, component, label }) => ({ ref, component, label }));
    return { startedMs, routeBefore, focusBefore, overlaysBefore, closedSincePrevCall };
  }

  finishCall(options: {
    round: number;
    slot: string;
    tool: string;
    input: unknown;
    status: 'ok' | 'error';
    agent: AppAgent;
    begin: ReturnType<RunDiagnosticRecorder['beginCall']>;
    analysis?: ToolErrorAnalysis;
    navigated?: boolean;
    navigationPending?: boolean;
    reportedOpenOverlays?: OverlayStateSummary[];
  }): { closedBeforeReturn: Array<{ ref: string; component: string; label?: string }> } {
    const {
      round,
      slot,
      tool,
      input,
      status,
      agent,
      begin,
      analysis,
      navigated,
      navigationPending,
      reportedOpenOverlays = [],
    } = options;
    const now = Date.now();
    const routeAfter =
      typeof window !== 'undefined' ? scrubRouteTemplate(window.location.pathname) : begin.routeBefore;
    const focusAfter = captureFocusRegion();
    const currentSnapshot = safeSnapshot(agent);
    const overlaysAfter = extractOpenOverlays(currentSnapshot);
    const afterRefs = new Set(overlaysAfter.map((o) => o.ref));
    const closedBeforeReturn = reportedOpenOverlays
      .filter((o) => o.open && !afterRefs.has(o.ref))
      .map(({ ref, component, label }) => ({ ref, component, label }));

    const recInput = isRecord(input) ? input : null;
    let stepCount: number | undefined;
    let targetRefs: string[] | undefined;
    let actions: string[] | undefined;
    if (tool === 'act' && recInput && Array.isArray(recInput.steps)) {
      stepCount = recInput.steps.length;
      targetRefs = recInput.steps
        .map((s) => (isRecord(s) && typeof s.ref === 'string' ? s.ref : ''))
        .filter(Boolean);
      actions = recInput.steps
        .map((s) => (isRecord(s) && typeof s.action === 'string' ? s.action : ''))
        .filter(Boolean);
    } else if (tool === 'query' && recInput && typeof recInput.within === 'string') {
      targetRefs = [recInput.within];
    }

    const record: ToolCallDiagnostic = {
      round,
      slot,
      tool,
      status,
      tsOffsetMs: Math.max(0, begin.startedMs - this.state.startedMs),
      durationMs: Math.max(0, now - begin.startedMs),
      routeBefore: begin.routeBefore,
      routeAfter,
      focusBefore: begin.focusBefore,
      focusAfter,
      ...(stepCount !== undefined ? { stepCount } : {}),
      ...(analysis?.completedSteps !== undefined ? { completedSteps: analysis.completedSteps } : {}),
      ...(analysis?.failedStepIndex !== undefined ? { failedStepIndex: analysis.failedStepIndex } : {}),
      ...(targetRefs?.length ? { targetRefs } : {}),
      ...(actions?.length ? { actions } : {}),
      ...(analysis ? { errorCode: analysis.code, errorCodes: analysis.codes } : {}),
      ...(navigated ? { navigated: true } : {}),
      ...(navigationPending ? { navigationPending: true } : {}),
      overlaysBefore: begin.overlaysBefore,
      overlaysAfter,
      ...(begin.closedSincePrevCall.length ? { closedSincePrevCall: begin.closedSincePrevCall } : {}),
      ...(closedBeforeReturn.length ? { closedBeforeReturn } : {}),
    };

    this.state.calls.push(record);
    if (this.state.calls.length > MAX_CALL_RECORDS) {
      this.state.calls.shift();
    }
    this.state.lastObservedSnapshot = currentSnapshot;
    this.state.lastOpenOverlays = overlaysAfter;
    if (status === 'ok') {
      this.state.recentClosedOverlays = [];
    }
    publishLatestDiagnostics(this.state);
    return { closedBeforeReturn };
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

let latestRun: DiagnosticRunState | null = null;
const diagListeners = new Set<() => void>();

function emitDiag() {
  for (const l of diagListeners) l();
}

function publishLatestDiagnostics(state: DiagnosticRunState) {
  latestRun = state;
  emitDiag();
}

export function clearLatestDiagnostics() {
  latestRun = null;
  emitDiag();
}

export function useHasDiagnostics(): boolean {
  return useSyncExternalStore(
    (listener) => {
      diagListeners.add(listener);
      return () => {
        diagListeners.delete(listener);
      };
    },
    () => Boolean(latestRun && latestRun.calls.length > 0),
    () => false,
  );
}

/**
 * Build a strictly whitelisted, scrubbed JSON diagnostic bundle for the latest run.
 * Never exports user prompts, assistant text, raw tool arguments/values, URLs, YAML,
 * profile names, or free-text SDK errors; dynamic refs and labels are anonymized with
 * stable per-export aliases so cross-step causality remains 100% readable.
 */
export function buildLatestDiagnosticReport(): string | null {
  if (!latestRun || latestRun.calls.length === 0) return null;
  const refAliases = new Map<string, string>();
  const labelAliases = new Map<string, string>();
  const aliasRef = (raw: string) => {
    let id = refAliases.get(raw);
    if (!id) {
      id = `ref_${refAliases.size + 1}`;
      refAliases.set(raw, id);
    }
    return id;
  };
  const aliasLabel = (raw?: string) => {
    if (!raw) return undefined;
    const key = raw.trim();
    if (!key) return undefined;
    let id = labelAliases.get(key);
    if (!id) {
      id = `label_${labelAliases.size + 1}`;
      labelAliases.set(key, id);
    }
    return id;
  };
  const scrubOverlay = (o: { ref: string; component: string; label?: string; open?: boolean; buttonCount?: number; itemCount?: number }) => ({
    ref: aliasRef(o.ref),
    component: o.component,
    ...(o.label ? { label: aliasLabel(o.label) } : {}),
    ...(typeof o.open === 'boolean' ? { open: o.open } : {}),
    ...(typeof o.buttonCount === 'number' ? { buttonCount: o.buttonCount } : {}),
    ...(typeof o.itemCount === 'number' ? { itemCount: o.itemCount } : {}),
  });

  const errorCounts: Partial<Record<ToolErrorCode, number>> = {};
  let errorTotal = 0;
  for (const call of latestRun.calls) {
    if (call.status === 'error') {
      errorTotal += 1;
      const code = call.errorCode ?? 'unknown';
      errorCounts[code] = (errorCounts[code] ?? 0) + 1;
    }
  }

  const report = {
    schemaVersion: 1,
    privacy: 'whitelisted-structural-only',
    runId: latestRun.id,
    startedAt: latestRun.startedAt,
    model: latestRun.model,
    initialRoute: latestRun.initialRoute,
    summary: {
      totalCalls: latestRun.calls.length,
      errorCalls: errorTotal,
      errorCounts,
    },
    calls: latestRun.calls.map((c) => ({
      round: c.round,
      slot: c.slot,
      tool: c.tool,
      status: c.status,
      tsOffsetMs: c.tsOffsetMs,
      durationMs: c.durationMs,
      routeBefore: c.routeBefore,
      routeAfter: c.routeAfter,
      focusBefore: c.focusBefore,
      focusAfter: c.focusAfter,
      ...(c.stepCount !== undefined ? { stepCount: c.stepCount } : {}),
      ...(c.completedSteps !== undefined ? { completedSteps: c.completedSteps } : {}),
      ...(c.failedStepIndex !== undefined ? { failedStepIndex: c.failedStepIndex } : {}),
      ...(c.targetRefs?.length ? { targets: c.targetRefs.map((r) => (/^c\d+$/.test(r) ? aliasRef(r) : aliasLabel(r))) } : {}),
      ...(c.actions?.length ? { actions: c.actions } : {}),
      ...(c.errorCode ? { errorCode: c.errorCode, errorCodes: c.errorCodes } : {}),
      ...(c.navigated ? { navigated: true } : {}),
      ...(c.navigationPending ? { navigationPending: true } : {}),
      overlaysBefore: c.overlaysBefore.map(scrubOverlay),
      overlaysAfter: c.overlaysAfter.map(scrubOverlay),
      ...(c.closedSincePrevCall?.length ? { closedSincePrevCall: c.closedSincePrevCall.map(scrubOverlay) } : {}),
      ...(c.closedBeforeReturn?.length ? { closedBeforeReturn: c.closedBeforeReturn.map(scrubOverlay) } : {}),
    })),
    overlayTransitions: latestRun.overlayTransitions.map((t) => ({
      tsOffsetMs: t.tsOffsetMs,
      ref: aliasRef(t.ref),
      component: t.component,
      ...(t.label ? { label: aliasLabel(t.label) } : {}),
      open: t.open,
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.source ? { source: t.source } : {}),
    })),
  };

  return JSON.stringify(report, null, 2);
}
