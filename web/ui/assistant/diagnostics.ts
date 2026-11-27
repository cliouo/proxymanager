'use client';

import { useSyncExternalStore } from 'react';
import { elementOf } from '@ui-sdk/react/observe';
import type { AgentComponent, AppAgent, ObservedChange } from '@/ui/agent';

export type ToolErrorCode =
  | 'component_missing'
  | 'label_ambiguous'
  | 'option_as_component'
  | 'overlay_closed'
  | 'overlay_blocked'
  | 'control_disabled'
  | 'invalid_args'
  | 'user_rejected'
  | 'unknown';

export const TOOL_ERROR_LABELS: Record<ToolErrorCode, string> = {
  component_missing: '组件缺失',
  label_ambiguous: '标签歧义',
  option_as_component: '把选项当组件',
  overlay_closed: '观察到弹层关闭',
  overlay_blocked: '被弹层隔离',
  control_disabled: '控件已禁用',
  invalid_args: '参数格式',
  user_rejected: '用户拒绝或中断',
  unknown: '未知',
};

export interface ToolErrorAnalysis {
  code: ToolErrorCode;
  codes: ToolErrorCode[];
  hint?: string;
  errorPattern?: string;
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

export type DiagnosticSegmentTrigger = 'message' | 'continue';
export type DiagnosticSegmentEndReason = 'done' | 'cap' | 'interrupted' | 'error';

export interface DiagnosticSegmentSummary {
  index: number;
  trigger: DiagnosticSegmentTrigger;
  startedAt: string;
  tsOffsetMs: number;
  initialRoute: string;
  endReason?: DiagnosticSegmentEndReason;
  totalCalls: number;
  errorCalls: number;
}

export interface ActOutcomeCounts {
  changesCount: number;
  appearedCount: number;
  goneCount: number;
}

export interface ToolCallDiagnostic {
  segment: number;
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
  errorPattern?: string;
  navigated?: boolean;
  navigationPending?: boolean;
  changesCount?: number;
  appearedCount?: number;
  goneCount?: number;
  noEffect?: boolean;
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
  nextSegmentIndex: number;
  segments: DiagnosticSegmentSummary[];
  droppedSegments: number;
  calls: ToolCallDiagnostic[];
  totalRecordedCalls: number;
  totalErrorCalls: number;
  totalNoEffectActCalls: number;
  totalErrorCounts: Partial<Record<ToolErrorCode, number>>;
  droppedCalls: number;
  overlayTransitions: OverlayTransitionEvent[];
  totalRecordedOverlayTransitions: number;
  droppedOverlayTransitions: number;
  lastObservedSnapshot: AgentComponent[];
  lastOpenOverlays: OverlayStateSummary[];
  recentClosedOverlays: OverlayTransitionEvent[];
}

export const MAX_CALL_RECORDS = 200;
export const MAX_OVERLAY_EVENTS = 200;
export const MAX_SEGMENTS = 20;
const OVERLAY_KINDS = new Set(['popover', 'menu', 'dialog', 'alertdialog', 'combobox', 'select', 'command']);
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function extractActOutcomeCounts(data: unknown): ActOutcomeCounts | undefined {
  if (!isRecord(data)) return undefined;
  let changesCount = 0;
  let goneCount = 0;
  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (!isRecord(step)) continue;
      if (Array.isArray(step.changes)) changesCount += step.changes.length;
      if (Array.isArray(step.gone)) goneCount += step.gone.length;
    }
  }
  const appearedCount = Array.isArray(data.appeared) ? data.appeared.length : 0;
  return { changesCount, appearedCount, goneCount };
}

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

export function scrubErrorPattern(message: string): string | undefined {
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  const out = trimmed
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/Its labels:[\s\S]*$/i, 'Its labels: <list>')
    .replace(/names \d+ components:[\s\S]*$/i, 'names <n> components: <list>')
    .replace(/"[^"]*"/g, '"<text>"')
    .replace(/'[^']*'/g, "'<text>'")
    .replace(/「[^」]*」/g, '「<text>」')
    .replace(/\bc\d+\b/g, '<ref>')
    .replace(/(?<![A-Za-z0-9_])\/(?:[A-Za-z0-9._:@%-]+(?:\/[A-Za-z0-9._:@%-]*)*)/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return undefined;
  return out.length > 140 ? `${out.slice(0, 139)}…` : out;
}

function isElementDisabledOrBusy(el: Element | null): { disabled: boolean; busy: boolean } {
  if (!el) return { disabled: false, busy: false };
  const busy = el.getAttribute('aria-busy') === 'true';
  const disabled =
    busy ||
    el.hasAttribute('disabled') ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.hasAttribute('data-disabled');
  return { disabled, busy };
}

function collectActiveFormValidationHints(): { busy: boolean; reasons: string[] } {
  if (typeof document === 'undefined') return { busy: false, reasons: [] };
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]')].filter(
    (el) => !el.closest('[data-agent-hidden]'),
  );
  const scope: Element | null = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document.getElementById('main');
  if (!scope) return { busy: false, reasons: [] };

  let busy = false;
  for (const btn of scope.querySelectorAll('button[aria-busy="true"]')) {
    if (!btn.closest('[data-agent-hidden]')) {
      busy = true;
      break;
    }
  }

  const reasons = new Set<string>();
  const addText = (text: string | null | undefined) => {
    const clean = (text ?? '').replace(/\s+/g, ' ').trim();
    if (clean && clean.length <= 120) reasons.add(clean);
  };

  for (const invalid of scope.querySelectorAll('[aria-invalid="true"]')) {
    if (invalid.closest('[data-agent-hidden]')) continue;
    const described = invalid.getAttribute('aria-describedby') ?? '';
    for (const id of described.split(/\s+/).filter(Boolean)) {
      const target = document.getElementById(id);
      if (target && !target.closest('[data-agent-hidden]')) addText(target.textContent);
    }
  }
  for (const node of scope.querySelectorAll('[id$="-error"], .text-bad, [data-validation-hint]')) {
    if (node.closest('[data-agent-hidden]')) continue;
    addText(node.textContent);
  }

  return { busy, reasons: [...reasons].slice(0, 4) };
}

function buildDisabledHint(busyHint: boolean): string {
  const { busy, reasons } = collectActiveFormValidationHints();
  if (busyHint || busy) {
    return '目标控件当前正在提交（aria-busy），请等待提交完成或调用 snapshot 确认结果，不要重复点击。';
  }
  if (reasons.length > 0) {
    return `目标控件当前已禁用，无法操作。页面校验提示：${reasons.join('；')}。请先补齐或修正表单字段后再试。`;
  }
  return '目标控件当前已禁用，无法操作。请先检查必填项、字段校验错误，或确认是否尚未修改（无变更时保存按钮禁用）。';
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
  const errorPattern = scrubErrorPattern(message);
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
    return { code: 'user_rejected', codes, errorPattern, failedStepIndex, completedSteps };
  }

  if (/isn't available to agents here/i.test(message)) {
    pushCode('overlay_blocked');
    const openOverlays = extractOpenOverlays(currentSnapshot);
    const dialogNames = openOverlays
      .filter((o) => o.component === 'dialog' || o.component === 'alert-dialog' || o.component === 'alertdialog')
      .map((o) => o.label || o.component);
    const hint =
      dialogNames.length > 0
        ? `当前弹层（${dialogNames.join('、')}）尚未关闭，背景页控件已被隔离；请先完成或关闭该弹层，再在下一轮操作背景页控件（不要把连续创建多条合并在同一次 act 中）。`
        : '目标控件当前对 AI 不可用或已被隐藏；请调用 snapshot 确认当前可操作的控件。';
    return { code: 'overlay_blocked', codes, errorPattern, failedStepIndex, completedSteps, hint };
  }

  const noItemMatch = message.match(/^No item "([^"]+)" in ([^(\n]+?)\s*\((c\d+)\)/i);
  if (noItemMatch) {
    const [, badItem, rawCompName, matchedRef] = noItemMatch;
    const parentComp = currentSnapshot.find((c) => c.ref === matchedRef);
    const validValues = (parentComp?.items ?? [])
      .map((it) => (typeof it?.value === 'string' ? it.value : ''))
      .filter(Boolean)
      .slice(0, 10);
    pushCode('invalid_args');
    const hint = validValues.length
      ? `「${rawCompName.trim()}」没有选项「${badItem}」，请改用有效 value：${validValues.join('、')}。`
      : `「${rawCompName.trim()}」没有选项「${badItem}」，请先通过 snapshot 或 query 核对选项的 value。`;
    return { code: 'invalid_args', codes, errorPattern, failedStepIndex, completedSteps, hint };
  }

  const noButtonMatch = message.match(/^No button "([^"]+)" in (c\d+)/i);
  if (noButtonMatch) {
    const [, badBtn] = noButtonMatch;
    pushCode('invalid_args');
    return {
      code: 'invalid_args',
      codes,
      errorPattern,
      failedStepIndex,
      completedSteps,
      hint: `目标容器内没有按钮「${badBtn}」；如果该按钮属于背景页面，请先关闭当前弹层后再在下一轮点击，或从报错列出的 Buttons 中选择。`,
    };
  }

  if (/\bis disabled\b|cannot press disabled/i.test(message)) {
    pushCode('control_disabled');
    return {
      code: 'control_disabled',
      codes,
      errorPattern,
      failedStepIndex,
      completedSteps,
      hint: buildDisabledHint(false),
    };
  }

  if (/合法的 JSON|Invalid|must be an array|Unknown action|missing required/i.test(message)) {
    pushCode('invalid_args');
    return { code: 'invalid_args', codes, errorPattern, failedStepIndex, completedSteps };
  }

  const ambigMatch = message.match(/^"([^"]+)" names (\d+) components:/);
  if (ambigMatch) {
    pushCode('label_ambiguous');
    return {
      code: 'label_ambiguous',
      codes,
      errorPattern,
      failedStepIndex,
      completedSteps,
      hint: `「${ambigMatch[1]}」在当前页面对应多个同名控件，请先根据上下文确认目标，再用报错列出的精确 ref 调用。`,
    };
  }

  // Case A: ui-sdk matched the option text to a parent command/select/combobox/tabs and rejected `press`,
  // OR rejected `press` on a disabled/busy button.
  const wrongPressMatch = message.match(/^([a-z-]+)\s+(c\d+)\s+(?:has nothing to press|has no action|is disabled)/i);
  if (wrongPressMatch) {
    const [, kind, matchedRef] = wrongPressMatch;
    const failedRef = typeof failedStep?.ref === 'string' ? failedStep.ref.trim() : '';
    const failedArg =
      Array.isArray(failedStep?.args) && typeof failedStep.args[0] === 'string' ? failedStep.args[0].trim() : '';
    const parentComp = currentSnapshot.find((c) => c.ref === matchedRef);

    // Check if the matched control itself is disabled or busy (e.g. submit button before validation passes).
    let domState = { disabled: false, busy: false };
    try {
      domState = isElementDisabledOrBusy(elementOf(matchedRef));
    } catch {
      /* ignore lookup failure */
    }
    const compDisabled = Boolean((parentComp as unknown as Record<string, unknown> | undefined)?.disabled);
    if (domState.disabled || compDisabled || (kind === 'button' && /has nothing to press|has no action/i.test(message))) {
      pushCode('control_disabled');
      return {
        code: 'control_disabled',
        codes,
        errorPattern,
        failedStepIndex,
        completedSteps,
        hint: buildDisabledHint(domState.busy),
      };
    }

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
        return { code: 'option_as_component', codes, errorPattern, hint, failedStepIndex, completedSteps };
      }
    }
    pushCode('invalid_args');
    return { code: 'invalid_args', codes, errorPattern, failedStepIndex, completedSteps };
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
      return { code: 'option_as_component', codes, errorPattern, hint, failedStepIndex, completedSteps };
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
          errorPattern,
          failedStepIndex,
          completedSteps,
          hint: `「${m.parentLabel}」（${m.parentComponent}）当前已关闭，且「${m.displayLabel}」是其内部选项；请先重新打开或调用 snapshot 确认当前界面，再用 ${m.action} 传入目标 value。`,
        };
      }
      if (wasInPreviousSnapshot || closedMatch) {
        return {
          code: 'overlay_closed',
          codes,
          errorPattern,
          failedStepIndex,
          completedSteps,
          hint: `「${wanted}」在上一轮曾出现，但对应浮层现已关闭；请先重新打开该浮层或调用 snapshot 核对当前可用控件。`,
        };
      }
    }

    pushCode('component_missing');
    return { code: 'component_missing', codes, errorPattern, failedStepIndex, completedSteps };
  }

  pushCode('unknown');
  return { code: 'unknown', codes, errorPattern, failedStepIndex, completedSteps };
}

export class RunDiagnosticRecorder {
  private readonly state: DiagnosticRunState;
  private readonly segment: DiagnosticSegmentSummary;
  private unsubscribe: (() => void) | null = null;

  constructor(options: {
    model: string;
    initialRoute: string;
    agent?: AppAgent;
    trigger?: DiagnosticSegmentTrigger;
    continueSession?: boolean;
  }) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const route = scrubRouteTemplate(options.initialRoute);
    const trigger: DiagnosticSegmentTrigger = options.trigger ?? 'message';

    if (options.continueSession && latestRun) {
      this.state = latestRun;
      this.state.model = options.model;
      const index = this.state.nextSegmentIndex++;
      this.segment = {
        index,
        trigger,
        startedAt: nowIso,
        tsOffsetMs: Math.max(0, now - this.state.startedMs),
        initialRoute: route,
        totalCalls: 0,
        errorCalls: 0,
      };
      this.state.segments.push(this.segment);
      if (this.state.segments.length > MAX_SEGMENTS) {
        this.state.segments.shift();
        this.state.droppedSegments += 1;
      }
    } else {
      this.segment = {
        index: 0,
        trigger,
        startedAt: nowIso,
        tsOffsetMs: 0,
        initialRoute: route,
        totalCalls: 0,
        errorCalls: 0,
      };
      this.state = {
        id: `run_${now.toString(36)}`,
        startedAt: nowIso,
        startedMs: now,
        model: options.model,
        initialRoute: route,
        nextSegmentIndex: 1,
        segments: [this.segment],
        droppedSegments: 0,
        calls: [],
        totalRecordedCalls: 0,
        totalErrorCalls: 0,
        totalNoEffectActCalls: 0,
        totalErrorCounts: {},
        droppedCalls: 0,
        overlayTransitions: [],
        totalRecordedOverlayTransitions: 0,
        droppedOverlayTransitions: 0,
        lastObservedSnapshot: [],
        lastOpenOverlays: [],
        recentClosedOverlays: [],
      };
    }

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
    this.state.totalRecordedOverlayTransitions += 1;
    this.state.overlayTransitions.push(entry);
    if (this.state.overlayTransitions.length > MAX_OVERLAY_EVENTS) {
      this.state.overlayTransitions.shift();
      this.state.droppedOverlayTransitions += 1;
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
      typeof window !== 'undefined' ? scrubRouteTemplate(window.location.pathname) : this.segment.initialRoute;
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
    actOutcome?: ActOutcomeCounts;
    settledAfterBusy?: boolean;
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
      actOutcome,
      settledAfterBusy = false,
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

    const overlaysChanged =
      begin.overlaysBefore.length !== overlaysAfter.length ||
      begin.overlaysBefore.some((o, i) => overlaysAfter[i]?.ref !== o.ref || overlaysAfter[i]?.open !== o.open);
    const noEffect =
      tool === 'act' &&
      status === 'ok' &&
      !navigated &&
      !settledAfterBusy &&
      !overlaysChanged &&
      actOutcome !== undefined &&
      actOutcome.changesCount === 0 &&
      actOutcome.appearedCount === 0 &&
      actOutcome.goneCount === 0;

    const record: ToolCallDiagnostic = {
      segment: this.segment.index,
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
      ...(analysis
        ? {
            errorCode: analysis.code,
            errorCodes: analysis.codes,
            ...(analysis.errorPattern ? { errorPattern: analysis.errorPattern } : {}),
          }
        : {}),
      ...(navigated ? { navigated: true } : {}),
      ...(navigationPending ? { navigationPending: true } : {}),
      ...(actOutcome
        ? {
            changesCount: actOutcome.changesCount,
            appearedCount: actOutcome.appearedCount,
            goneCount: actOutcome.goneCount,
          }
        : {}),
      ...(noEffect ? { noEffect: true } : {}),
      overlaysBefore: begin.overlaysBefore,
      overlaysAfter,
      ...(begin.closedSincePrevCall.length ? { closedSincePrevCall: begin.closedSincePrevCall } : {}),
      ...(closedBeforeReturn.length ? { closedBeforeReturn } : {}),
    };

    this.segment.totalCalls += 1;
    this.state.totalRecordedCalls += 1;
    if (status === 'error') {
      this.segment.errorCalls += 1;
      this.state.totalErrorCalls += 1;
      const code = analysis?.code ?? 'unknown';
      this.state.totalErrorCounts[code] = (this.state.totalErrorCounts[code] ?? 0) + 1;
    }
    if (noEffect) {
      this.state.totalNoEffectActCalls += 1;
    }

    this.state.calls.push(record);
    if (this.state.calls.length > MAX_CALL_RECORDS) {
      this.state.calls.shift();
      this.state.droppedCalls += 1;
    }
    this.state.lastObservedSnapshot = currentSnapshot;
    this.state.lastOpenOverlays = overlaysAfter;
    if (status === 'ok') {
      this.state.recentClosedOverlays = [];
    }
    publishLatestDiagnostics(this.state);
    return { closedBeforeReturn };
  }

  finishSegment(endReason: DiagnosticSegmentEndReason) {
    this.segment.endReason = endReason;
    if (this.state.calls.length > 0) {
      publishLatestDiagnostics(this.state);
    }
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

  const scrubbedCalls = latestRun.calls.map((c) => {
    const targets = c.targetRefs?.length
      ? c.targetRefs
          .map((r) => (/^c\d+$/.test(r) ? aliasRef(r) : aliasLabel(r)))
          .filter((v): v is string => typeof v === 'string')
      : undefined;
    return {
      segment: c.segment,
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
      ...(targets?.length ? { targets } : {}),
      ...(c.actions?.length ? { actions: c.actions } : {}),
      ...(c.errorCode
        ? {
            errorCode: c.errorCode,
            errorCodes: c.errorCodes,
            ...(c.errorPattern ? { errorPattern: c.errorPattern } : {}),
          }
        : {}),
      ...(c.navigated ? { navigated: true } : {}),
      ...(c.navigationPending ? { navigationPending: true } : {}),
      ...(c.changesCount !== undefined ? { changesCount: c.changesCount } : {}),
      ...(c.appearedCount !== undefined ? { appearedCount: c.appearedCount } : {}),
      ...(c.goneCount !== undefined ? { goneCount: c.goneCount } : {}),
      ...(c.noEffect ? { noEffect: true } : {}),
      overlaysBefore: c.overlaysBefore.map(scrubOverlay),
      overlaysAfter: c.overlaysAfter.map(scrubOverlay),
      ...(c.closedSincePrevCall?.length ? { closedSincePrevCall: c.closedSincePrevCall.map(scrubOverlay) } : {}),
      ...(c.closedBeforeReturn?.length ? { closedBeforeReturn: c.closedBeforeReturn.map(scrubOverlay) } : {}),
    };
  });

  // Compute repeated (target, action) hotspots over retained calls to spotlight retry/stuck loops.
  const hotspotStats = new Map<
    string,
    {
      target: string;
      action: string;
      count: number;
      currentStreak: number;
      maxConsecutive: number;
      noEffectCount: number;
      errorCount: number;
    }
  >();
  for (const call of scrubbedCalls) {
    const seenInCall = new Set<string>();
    if (call.targets?.length) {
      for (let i = 0; i < call.targets.length; i++) {
        const target = call.targets[i];
        const action = call.tool === 'act' ? (call.actions?.[i] ?? 'act') : call.tool;
        const key = `${target}\u0000${action}`;
        let entry = hotspotStats.get(key);
        if (!entry) {
          entry = { target, action, count: 0, currentStreak: 0, maxConsecutive: 0, noEffectCount: 0, errorCount: 0 };
          hotspotStats.set(key, entry);
        }
        entry.count += 1;
        if (call.noEffect) entry.noEffectCount += 1;
        if (call.status === 'error') entry.errorCount += 1;
        seenInCall.add(key);
      }
    }
    for (const [key, entry] of hotspotStats) {
      if (seenInCall.has(key)) {
        entry.currentStreak += 1;
        if (entry.currentStreak > entry.maxConsecutive) entry.maxConsecutive = entry.currentStreak;
      } else {
        entry.currentStreak = 0;
      }
    }
  }
  const repeatedTargetHotspots = [...hotspotStats.values()]
    .filter((entry) => entry.count >= 3)
    .sort((a, b) => b.count - a.count || b.maxConsecutive - a.maxConsecutive)
    .slice(0, 8)
    .map(({ target, action, count, maxConsecutive, noEffectCount, errorCount }) => ({
      target,
      action,
      count,
      maxConsecutive,
      noEffectCount,
      errorCount,
    }));

  const report = {
    schemaVersion: 1,
    privacy: 'whitelisted-structural-only',
    runId: latestRun.id,
    startedAt: latestRun.startedAt,
    model: latestRun.model,
    initialRoute: latestRun.initialRoute,
    summary: {
      segmentCount: latestRun.segments.length + latestRun.droppedSegments,
      totalCalls: latestRun.totalRecordedCalls,
      retainedCalls: latestRun.calls.length,
      droppedCalls: latestRun.droppedCalls,
      ...(latestRun.droppedOverlayTransitions > 0
        ? { droppedOverlayTransitions: latestRun.droppedOverlayTransitions }
        : {}),
      errorCalls: latestRun.totalErrorCalls,
      errorCounts: { ...latestRun.totalErrorCounts },
      noEffectActCalls: latestRun.totalNoEffectActCalls,
      ...(repeatedTargetHotspots.length > 0 ? { repeatedTargetHotspots } : {}),
    },
    segments: latestRun.segments.map((s) => ({
      index: s.index,
      trigger: s.trigger,
      startedAt: s.startedAt,
      tsOffsetMs: s.tsOffsetMs,
      initialRoute: s.initialRoute,
      ...(s.endReason ? { endReason: s.endReason } : {}),
      totalCalls: s.totalCalls,
      errorCalls: s.errorCalls,
    })),
    calls: scrubbedCalls,
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
