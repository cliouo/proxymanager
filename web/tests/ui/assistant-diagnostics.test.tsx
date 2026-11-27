import { render } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ui-sdk/react/command';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppAllow } from '@/ui/agent';
import { dispatchAgentTool } from '@/ui/assistant/agent';
import {
  MAX_CALL_RECORDS,
  RunDiagnosticRecorder,
  analyzeToolError,
  buildLatestDiagnosticReport,
  clearLatestDiagnostics,
  scrubRouteTemplate,
} from '@/ui/assistant/diagnostics';
import { shouldCancelAssistantFocusOut } from '@/ui/primitives/overlay-scope';
import { ProfileSwitcher } from '@/ui/shell/profile-switcher';
import { setUi } from '@/ui/shell/state';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/p/zeta',
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ profile: 'zeta' }),
}));

vi.mock('@/ui/data/hooks', () => ({
  useProfiles: () => ({
    data: [
      { id: 'p1', name: 'zeta', display_name: '主力配置', kind: 'profile' },
      { id: 'p2', name: 'raozhenhua', display_name: 'raozhenhua', kind: 'profile' },
    ],
  }),
  useSources: () => ({ data: [] }),
  usePools: () => ({ data: [] }),
}));

afterEach(() => {
  clearLatestDiagnostics();
  setUi({ assistantOpen: false, assistantDocked: false });
  pushMock.mockReset();
  vi.restoreAllMocks();
});

describe('P0 assistant overlay persistence, error taxonomy, and scrubbed diagnostics', () => {
  test('shouldCancelAssistantFocusOut handles both Popover focusin (target) and Combobox focusout (relatedTarget)', () => {
    const { container } = render(
      <div>
        <div data-assistant-surface>
          <textarea aria-label="助手输入" />
        </div>
        <div data-takeover-bar>
          <button type="button">暂停</button>
        </div>
        <button type="button" id="outside-btn">
          外部按钮
        </button>
      </div>,
    );
    const textarea = container.querySelector('textarea')!;
    const pauseBtn = container.querySelector('[data-takeover-bar] button')!;
    const outsideBtn = container.querySelector('#outside-btn')!;

    // Popover emits focusin with destination in event.target
    const popoverFocusIn = new FocusEvent('focusin', { bubbles: true });
    Object.defineProperty(popoverFocusIn, 'target', { value: textarea });
    expect(shouldCancelAssistantFocusOut({ reason: 'focus-out', event: popoverFocusIn }, true)).toBe(true);
    expect(shouldCancelAssistantFocusOut({ reason: 'focus-out', event: popoverFocusIn }, false)).toBe(false);

    // Combobox emits focusout with destination in event.relatedTarget
    const comboFocusOut = new FocusEvent('focusout', { relatedTarget: pauseBtn });
    expect(shouldCancelAssistantFocusOut({ reason: 'focus-out', event: comboFocusOut }, true)).toBe(true);

    // Moving focus to a regular outside workspace control MUST still close the overlay
    const outsideFocusOut = new FocusEvent('focusout', { relatedTarget: outsideBtn });
    expect(shouldCancelAssistantFocusOut({ reason: 'focus-out', event: outsideFocusOut }, true)).toBe(false);

    // Escape / outside-press must NOT be cancelled
    expect(shouldCancelAssistantFocusOut({ reason: 'escape-key', event: popoverFocusIn }, true)).toBe(false);
  });

  test('ProfileSwitcher deduplicates identical display_name/name text and gives 管理 a distinct accessible label', async () => {
    const agent = createAgent({ allow: createAppAllow() });
    setUi({ assistantOpen: true, assistantDocked: true });
    render(<ProfileSwitcher />);

    const opened = await dispatchAgentTool(
      'act',
      { steps: [{ ref: '切换配置文件：主力配置', action: 'press' }] },
      { agent },
    );
    expect(opened.kind).toBe('act');

    const snap = agent.snapshot();
    const cmd = snap.find((c) => c.component === 'command' && c.label === '搜索配置文件');
    expect(cmd).toBeTruthy();
    const labels = (cmd?.items ?? []).map((item) => item.label);
    expect(labels).toContain('raozhenhua');
    expect(labels.some((l) => l.includes('raozhenhuaraozhenhua'))).toBe(false);

    // Bottom button must be uniquely labelled "管理配置文件" rather than ambiguous "管理"
    expect(snap.some((c) => c.label === '管理配置文件')).toBe(true);
    expect(snap.some((c) => c.label === '管理')).toBe(false);
  });

  test('analyzeToolError classifies command items as option_as_component, ambiguity, and closed overlays', async () => {
    const agent = createAgent({ allow: createAppAllow() });
    const onRun = vi.fn();

    render(
      <Command>
        <CommandInput aria-label="搜索配置文件" />
        <CommandList>
          <CommandItem value="p2" label="raozhenhua" onSelect={() => onRun('p2')}>
            raozhenhua
          </CommandItem>
        </CommandList>
      </Command>,
    );

    const errRes = await dispatchAgentTool(
      'act',
      { steps: [{ ref: 'raozhenhua', action: 'press' }] },
      { agent },
    );
    expect(errRes.kind).toBe('error');
    const payload = JSON.parse(errRes.modelContent) as { errorCode?: string; hint?: string };
    expect(payload.errorCode, errRes.modelContent).toBe('option_as_component');
    expect(payload.hint).toContain('"ref":"搜索配置文件"');
    expect(payload.hint).toContain('"action":"run"');
    expect(payload.hint).toContain('"args":["p2"]');

    const ambig = analyzeToolError({
      name: 'act',
      data: { ok: false, error: { step: 1, message: '"管理" names 3 components: c1 管理, c2 管理, c3 管理.' }, steps: [{ step: 0, ref: 'c0' }] },
      currentSnapshot: [],
    });
    expect(ambig.code).toBe('label_ambiguous');
    expect(ambig.failedStepIndex).toBe(1);
    expect(ambig.completedSteps).toBe(1);
    expect(ambig.hint).toContain('精确 ref');

    const closed = analyzeToolError({
      name: 'query',
      data: { error: 'No component "搜索配置文件" on the page.' },
      currentSnapshot: [],
      lastObservedSnapshot: [
        { ref: 'c9', component: 'command', label: '搜索配置文件', actions: ['run'] },
      ],
      recentClosedOverlays: [{ ref: 'c8', component: 'popover', label: '切换配置文件：主力配置' }],
    });
    expect(closed.code).toBe('overlay_closed');
    expect(closed.hint).toContain('已关闭');
  });

  test('RunDiagnosticRecorder captures successful and failed steps and exports strictly scrubbed whitelist JSON', async () => {
    const agent = createAgent({ allow: createAppAllow() });
    render(
      <Command>
        <CommandInput aria-label="搜索配置文件" />
        <CommandList>
          <CommandItem value="p2" label="secret-profile-alpha" onSelect={() => undefined}>
            secret-profile-alpha
          </CommandItem>
        </CommandList>
      </Command>,
    );

    const recorder = new RunDiagnosticRecorder({
      model: 'deepseek-chat',
      initialRoute: '/p/secret-profile-alpha/groups/550e8400-e29b-41d4-a716-446655440000',
      agent,
    });
    try {
      await dispatchAgentTool('snapshot', {}, { agent, diagnostics: recorder, round: 0, slot: '0:0' });
      await dispatchAgentTool(
        'act',
        { steps: [{ ref: 'secret-profile-alpha', action: 'press' }] },
        { agent, diagnostics: recorder, round: 1, slot: '1:0' },
      );

      expect(scrubRouteTemplate('/p/raozhenhua/groups/550e8400-e29b-41d4-a716-446655440000')).toBe('/p/:profile/groups/:id');
      expect(scrubRouteTemplate('/sources/sub-123/naming')).toBe('/sources/:id/naming');

      const rawReport = buildLatestDiagnosticReport();
      expect(rawReport).toBeTruthy();
      // Privacy invariant: raw profile names and secret values must never appear in exported diagnostics
      expect(rawReport!).not.toContain('secret-profile-alpha');
      expect(rawReport!).not.toContain('550e8400');

      const parsed = JSON.parse(rawReport!) as {
        schemaVersion: number;
        privacy: string;
        initialRoute: string;
        summary: { totalCalls: number; errorCalls: number; errorCounts: Record<string, number> };
        calls: Array<{ tool: string; status: string; errorCode?: string; focusBefore: string; focusAfter: string }>;
      };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.privacy).toBe('whitelisted-structural-only');
      expect(parsed.initialRoute).toBe('/p/:profile/groups/:id');
      expect(parsed.summary.totalCalls).toBe(2);
      expect(parsed.summary.errorCalls).toBe(1);
      expect(parsed.summary.errorCounts.option_as_component).toBe(1);
      expect(parsed.calls[0].tool).toBe('snapshot');
      expect(parsed.calls[0].status).toBe('ok');
      expect(parsed.calls[1].errorCode).toBe('option_as_component');
    } finally {
      recorder.dispose();
    }
  });

  test('accumulates multi-segment runs across continue, tracks truncation past 200 calls, and flags no-effect hotspot loops', async () => {
    const fakeAgent = {
      snapshot: () => [],
      query: vi.fn(async () => []),
      act: vi.fn(async () => ({ ok: true, steps: [{ step: 0, ref: 'c72' }], appeared: [] })),
    } as unknown as ReturnType<typeof createAgent>;

    // Segment 0: initial user message hits cap after 3 no-effect presses on the same button
    const seg0 = new RunDiagnosticRecorder({
      model: 'deepseek-flash',
      initialRoute: '/p/secret-alpha/profiles',
      agent: fakeAgent,
      trigger: 'message',
      continueSession: true,
    });
    try {
      for (let r = 0; r < 3; r++) {
        await dispatchAgentTool(
          'act',
          { steps: [{ ref: '创建并打开 secret-alpha', action: 'press' }] },
          { agent: fakeAgent, diagnostics: seg0, round: r, slot: `${r}:0` },
        );
      }
      seg0.finishSegment('cap');
    } finally {
      seg0.dispose();
    }

    // Segment 1: user clicks "继续" (continueSession: true) and presses same button once more, then finishes
    const seg1 = new RunDiagnosticRecorder({
      model: 'deepseek-flash',
      initialRoute: '/p/secret-alpha/profiles',
      agent: fakeAgent,
      trigger: 'continue',
      continueSession: true,
    });
    try {
      await dispatchAgentTool(
        'act',
        { steps: [{ ref: '创建并打开 secret-alpha', action: 'press' }] },
        { agent: fakeAgent, diagnostics: seg1, round: 0, slot: '0:0' },
      );
      seg1.finishSegment('done');
    } finally {
      seg1.dispose();
    }

    const raw = buildLatestDiagnosticReport();
    expect(raw).toBeTruthy();
    expect(raw!).not.toContain('secret-alpha');

    const report = JSON.parse(raw!) as {
      summary: {
        segmentCount: number;
        totalCalls: number;
        retainedCalls: number;
        droppedCalls: number;
        noEffectActCalls: number;
        repeatedTargetHotspots?: Array<{
          target: string;
          action: string;
          count: number;
          maxConsecutive: number;
          noEffectCount: number;
          errorCount: number;
        }>;
      };
      segments: Array<{ index: number; trigger: string; endReason?: string; totalCalls: number }>;
      calls: Array<{
        segment: number;
        changesCount?: number;
        appearedCount?: number;
        goneCount?: number;
        noEffect?: boolean;
        targets?: string[];
      }>;
    };

    expect(report.summary.segmentCount).toBe(2);
    expect(report.summary.totalCalls).toBe(4);
    expect(report.summary.retainedCalls).toBe(4);
    expect(report.summary.droppedCalls).toBe(0);
    expect(report.summary.noEffectActCalls).toBe(4);
    expect(report.segments.map((s) => ({ index: s.index, trigger: s.trigger, endReason: s.endReason, totalCalls: s.totalCalls }))).toEqual([
      { index: 0, trigger: 'message', endReason: 'cap', totalCalls: 3 },
      { index: 1, trigger: 'continue', endReason: 'done', totalCalls: 1 },
    ]);
    // Same anonymized target alias across segments 0 and 1
    expect(report.calls[0].segment).toBe(0);
    expect(report.calls[3].segment).toBe(1);
    expect(report.calls[0].targets?.[0]).toBe(report.calls[3].targets?.[0]);
    expect(report.calls[0].noEffect).toBe(true);
    expect(report.calls[0].changesCount).toBe(0);
    expect(report.summary.repeatedTargetHotspots?.[0]).toEqual({
      target: report.calls[0].targets?.[0],
      action: 'press',
      count: 4,
      maxConsecutive: 4,
      noEffectCount: 4,
      errorCount: 0,
    });

    // Overflow past MAX_CALL_RECORDS (200) must report droppedCalls accurately without losing total counts
    const seg2 = new RunDiagnosticRecorder({
      model: 'deepseek-flash',
      initialRoute: '/profiles',
      agent: fakeAgent,
      trigger: 'continue',
      continueSession: true,
    });
    try {
      for (let i = 0; i < MAX_CALL_RECORDS + 5; i++) {
        const begin = seg2.beginCall(fakeAgent);
        seg2.finishCall({
          round: i,
          slot: `${i}:0`,
          tool: 'snapshot',
          input: {},
          status: 'ok',
          agent: fakeAgent,
          begin,
        });
      }
      seg2.finishSegment('done');
    } finally {
      seg2.dispose();
    }

    const overflow = JSON.parse(buildLatestDiagnosticReport()!) as {
      summary: { totalCalls: number; retainedCalls: number; droppedCalls: number; noEffectActCalls: number };
      calls: unknown[];
    };
    expect(overflow.summary.totalCalls).toBe(4 + MAX_CALL_RECORDS + 5);
    expect(overflow.summary.retainedCalls).toBe(MAX_CALL_RECORDS);
    expect(overflow.calls).toHaveLength(MAX_CALL_RECORDS);
    expect(overflow.summary.droppedCalls).toBe(9);
    expect(overflow.summary.noEffectActCalls).toBe(4);
  });
});
