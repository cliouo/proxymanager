import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  acquireTakeover,
  AgentHost,
  clearAgentConfirms,
  createAppAllow,
  executeCustomTool,
  getTakeoverSnapshot,
  isTakeoverLocked,
  markTakeoverRouteDrifted,
  PAUSE_AUTO_STOP_MS,
  pauseTakeover,
  releaseTakeover,
  requestAgentConfirm,
  resetTakeoverForTests,
  resumeTakeover,
  runAgentAct,
  stopTakeover,
  waitIfPaused,
  type AppAgent,
} from '@/ui/agent';
import { dispatchAgentTool, runAgent } from '@/ui/assistant/agent';
import { useHotkey } from '@/ui/shell/hotkeys';
import type { AssistantConfig } from '@/ui/data/types';

import { setTrustCheckForTests } from '@/ui/agent/takeover';

const TRUSTED_EVENTS = new WeakSet<Event>();

function makeTrustedEvent<T extends Event>(event: T): T {
  TRUSTED_EVENTS.add(event);
  return event;
}

function makePointerEvent(type: string, init: PointerEventInit & { pointerId?: number; pointerType?: string } = {}) {
  const EventCtor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
  const event = new EventCtor(type, { bubbles: true, cancelable: true, ...init });
  if (!('pointerId' in event)) {
    Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1, configurable: true });
  }
  if (!('pointerType' in event)) {
    Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse', configurable: true });
  }
  return makeTrustedEvent(event);
}

const TEST_CONFIG: AssistantConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-123456',
  model: 'deepseek-chat',
  thinking: 'disabled',
  reasoningEffort: 'high',
  maxTokens: 2048,
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AI workspace takeover', () => {
  beforeEach(() => {
    resetTakeoverForTests();
    clearAgentConfirms();
    setTrustCheckForTests((event) => TRUSTED_EVENTS.has(event));
  });

  afterEach(() => {
    cleanup();
    resetTakeoverForTests();
    clearAgentConfirms();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('enforces single-owner lease and ignores stale owner release', () => {
    const ownerA = new AbortController();
    const ownerB = new AbortController();

    expect(acquireTakeover(ownerA, { activityLabel: '操作 A' })).toBe(true);
    expect(isTakeoverLocked()).toBe(true);
    expect(acquireTakeover(ownerB, { activityLabel: '操作 B' })).toBe(false);

    releaseTakeover(ownerB);
    expect(isTakeoverLocked()).toBe(true);

    releaseTakeover(ownerA);
    expect(isTakeoverLocked()).toBe(false);
    expect(getTakeoverSnapshot().mode).toBe('idle');
  });

  it('pauses waitIfPaused, resumes cleanly, and auto-stops after 4 minutes', async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const onStop = vi.fn(() => owner.abort());
    acquireTakeover(owner, { onStop, activityLabel: '点击保存' });

    expect(pauseTakeover('click', 'workspace')).toBe('paused');
    expect(getTakeoverSnapshot().mode).toBe('paused');

    let resumed = false;
    const waiting = waitIfPaused(owner.signal, owner).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);

    resumeTakeover();
    await waiting;
    expect(resumed).toBe(true);
    expect(getTakeoverSnapshot().mode).toBe('standby');

    // Pause again and verify 4-minute auto-stop timeout.
    pauseTakeover('button', 'workspace');
    const waitingTimeout = waitIfPaused(owner.signal, owner);
    vi.advanceTimersByTime(PAUSE_AUTO_STOP_MS);
    await expect(waitingTimeout).rejects.toThrow();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(isTakeoverLocked()).toBe(false);
  });

  it('intercepts trusted clicks on SVG icons in workspace, swallows gesture tail, and allows exempt assistant clicks', () => {
    const owner = new AbortController();
    const onLeftClick = vi.fn();
    const onRightClick = vi.fn();
    const onStop = vi.fn(() => owner.abort());

    render(
      <div>
        <main id="main">
          <button type="button" onClick={onLeftClick}>
            <svg width="16" height="16">
              <path data-testid="left-svg-path" d="M0 0h16v16H0z" />
            </svg>
          </button>
        </main>
        <aside data-assistant-surface data-assistant-panel data-takeover-exempt>
          <button type="button" data-testid="assistant-btn" onClick={onRightClick}>
            右侧按钮
          </button>
        </aside>
        <AgentHost />
      </div>,
    );

    act(() => {
      acquireTakeover(owner, { onStop, activityLabel: '点击策略组' });
    });

    const svgPath = screen.getByTestId('left-svg-path');

    // Synthetic (non-trusted) events pass right through so @ui-sdk agent.act() is never blocked.
    const syntheticClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      svgPath.dispatchEvent(syntheticClick);
    });
    expect(syntheticClick.defaultPrevented).toBe(false);
    expect(onLeftClick).toHaveBeenCalledTimes(1);

    // Trusted click on SVG path inside left button must be blocked and pause takeover.
    const down = makePointerEvent('pointerdown', { pointerId: 7, pointerType: 'mouse' });
    act(() => {
      svgPath.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(getTakeoverSnapshot().mode).toBe('paused');

    // Trailing pointerup/click of that same gesture must be swallowed even if landing on the newly expanded Pause Bar.
    const resumeBtn = screen.getByRole('button', { name: /继续让 AI 操作/ });
    const trailingUp = makePointerEvent('pointerup', { pointerId: 7, pointerType: 'mouse' });
    const trailingClick = makeTrustedEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    act(() => {
      resumeBtn.dispatchEvent(trailingUp);
      resumeBtn.dispatchEvent(trailingClick);
    });
    expect(trailingUp.defaultPrevented).toBe(true);
    expect(trailingClick.defaultPrevented).toBe(true);
    expect(getTakeoverSnapshot().mode).toBe('paused');

    // A fresh click inside the exempt assistant panel passes through.
    const assistantBtn = screen.getByTestId('assistant-btn');
    const rightDown = makePointerEvent('pointerdown', { pointerId: 8, pointerType: 'mouse' });
    const rightClick = makeTrustedEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    act(() => {
      assistantBtn.dispatchEvent(rightDown);
      assistantBtn.dispatchEvent(rightClick);
    });
    expect(rightDown.defaultPrevented).toBe(false);
    expect(onRightClick).toHaveBeenCalledTimes(1);
    expect(onLeftClick).toHaveBeenCalledTimes(1);

    // Clicking "停止 AI，由我操作" calls onStop and unlocks.
    const stopBtn = screen.getByRole('button', { name: /停止 AI，由我操作/ });
    act(() => {
      stopBtn.click();
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(isTakeoverLocked()).toBe(false);
  });

  it('blocks right-side mod+s page hotkeys during takeover while allowing mod+j', () => {
    const owner = new AbortController();
    const onSave = vi.fn();
    const onToggleAssistant = vi.fn();

    function HotkeyHarness() {
      useHotkey('mod+s', onSave);
      useHotkey('mod+j', onToggleAssistant, { allowDuringTakeover: true });
      return (
        <aside data-assistant-surface data-assistant-panel data-takeover-exempt>
          <textarea data-testid="composer-area" />
        </aside>
      );
    }

    render(
      <>
        <HotkeyHarness />
        <AgentHost />
      </>,
    );

    const textarea = screen.getByTestId('composer-area');
    textarea.focus();
    act(() => {
      acquireTakeover(owner, { activityLabel: '编辑基础配置' });
    });

    const saveKey = makeTrustedEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }),
    );
    const toggleKey = makeTrustedEvent(
      new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }),
    );
    act(() => {
      textarea.dispatchEvent(saveKey);
      textarea.dispatchEvent(toggleKey);
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(onToggleAssistant).toHaveBeenCalledTimes(1);
    releaseTakeover(owner);
  });

  it('handles touch swipe without pausing and pauses on trusted tap click', () => {
    const owner = new AbortController();
    render(
      <div>
        <main id="main">
          <button type="button" data-testid="touch-target">
            列表项
          </button>
        </main>
        <AgentHost />
      </div>,
    );

    act(() => {
      acquireTakeover(owner, { activityLabel: '操作列表' });
    });

    const target = screen.getByTestId('touch-target');
    const touchDown = makePointerEvent('pointerdown', { pointerId: 2, pointerType: 'touch' });
    act(() => {
      target.dispatchEvent(touchDown);
    });
    expect(touchDown.defaultPrevented).toBe(true);
    expect(getTakeoverSnapshot().mode).toBe('standby');

    // Browser fires click only for tap (not swipe) -> pauses takeover.
    const tapClick = makeTrustedEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    act(() => {
      target.dispatchEvent(tapClick);
    });
    expect(tapClick.defaultPrevented).toBe(true);
    expect(getTakeoverSnapshot().mode).toBe('paused');
    releaseTakeover(owner);
  });

  it('pulses existing confirm card instead of stacking pause when confirmation is pending', async () => {
    const owner = new AbortController();
    acquireTakeover(owner, { activityLabel: '删除配置' });
    const confirmPromise = requestAgentConfirm(
      { ref: 'c1', component: 'button', action: 'press', label: '删除', confirm: '确认删除？', args: [] },
      { signal: owner.signal },
    );

    const beforeSeq = getTakeoverSnapshot().confirmPulseSeq;
    expect(pauseTakeover('click', 'workspace')).toBe('confirm-focused');
    expect(getTakeoverSnapshot().mode).toBe('standby');
    expect(getTakeoverSnapshot().confirmPulseSeq).toBe(beforeSeq + 1);

    owner.abort();
    await expect(confirmPromise).resolves.toBe(false);
  });

  it('blocks external WebMCP side effects while built-in run owns workspace', async () => {
    const owner = new AbortController();
    acquireTakeover(owner, { activityLabel: '站内操作中' });

    const allow = createAppAllow();
    const allowed = await allow(
      { ref: 'c1', component: 'button', action: 'press', label: '保存', args: [] },
      { signal: new AbortController().signal },
    );
    expect(allowed).toBe(false);

    const writeRes = (await executeCustomTool(
      'migrate_direct_alias',
      { expected_version: 1, expected_base_etag: 'etag' },
      { source: 'webmcp' },
    )) as { ok: boolean; error: string };
    expect(writeRes.ok).toBe(false);
    expect(writeRes.error).toContain('工作区正由站内 AI 助手使用');

    releaseTakeover(owner);
  });

  it('records dispatched_unverified when an in-flight act is aborted and invalidates stale step after route drift', async () => {
    const owner = new AbortController();
    let actStarted!: () => void;
    const actStartedPromise = new Promise<void>((resolve) => {
      actStarted = resolve;
    });

    const fakeAgent = {
      snapshot: () => [],
      query: vi.fn(async () => []),
      act: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            actStarted();
            owner.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    } as unknown as AppAgent;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'act',
                    arguments: JSON.stringify({ steps: [{ ref: '保存', action: 'press' }] }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const events: Array<{ type: string; result?: unknown }> = [];
    const runPromise = runAgent({
      config: TEST_CONFIG,
      system: 'sys',
      messages: [{ role: 'user', content: '点保存' }],
      signal: owner.signal,
      owner,
      onStop: () => owner.abort(),
      agent: fakeAgent,
      onEvent: (ev) => events.push(ev),
    });

    await actStartedPromise;
    expect(isTakeoverLocked()).toBe(true);
    stopTakeover('user');
    const status = await runPromise;
    expect(status).toBe('interrupted');

    const toolResult = events.find((e) => e.type === 'tool-result') as
      | { result: { modelContent: string } }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.result.modelContent).toContain('dispatched_unverified');

    // Route drift invalidation test:
    const owner2 = new AbortController();
    acquireTakeover(owner2, { activityLabel: '等待恢复' });
    markTakeoverRouteDrifted();
    expect(getTakeoverSnapshot().mode).toBe('paused');
    expect(getTakeoverSnapshot().routeDrifted).toBe(true);
    resumeTakeover();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_drift',
                    type: 'function',
                    function: {
                      name: 'act',
                      arguments: JSON.stringify({ steps: [{ ref: '旧按钮', action: 'press' }] }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '已重新确认' } }],
        }),
      );

    const actSpy = vi.fn(async () => ({ ok: true }));
    const driftEvents: Array<{ type: string; result?: { modelContent: string } }> = [];
    await runAgent({
      config: TEST_CONFIG,
      system: 'sys',
      messages: [{ role: 'user', content: '继续' }],
      signal: owner2.signal,
      owner: owner2,
      agent: { snapshot: () => [], query: vi.fn(async () => []), act: actSpy } as unknown as AppAgent,
      onEvent: (ev) => driftEvents.push(ev as never),
    });
    expect(actSpy).not.toHaveBeenCalled();
    expect(driftEvents.some((e) => e.type === 'tool-result' && e.result?.modelContent.includes('暂停期间页面或配置已切换'))).toBe(
      true,
    );
    releaseTakeover(owner2);
  });

  it('discards partial array from closed query when aborted mid-flight', async () => {
    const owner = new AbortController();
    let resolveQuery!: (val: unknown) => void;
    const fakeAgent = {
      snapshot: () => [],
      query: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveQuery = resolve;
          }),
      ),
      act: vi.fn(),
    } as unknown as AppAgent;

    const queryPromise = dispatchAgentTool(
      'query',
      { closed: true },
      { signal: owner.signal, owner, agent: fakeAgent },
    );
    await Promise.resolve();
    expect(isTakeoverLocked()).toBe(true);

    owner.abort();
    // Workspace stays locked until the in-flight closed query finishes restoring tabs.
    expect(isTakeoverLocked()).toBe(true);
    resolveQuery([{ ref: 'c1', component: 'input' }]);

    await expect(queryPromise).rejects.toThrow();
    expect(isTakeoverLocked()).toBe(false);
  });

  it('preserves direct runAgentAct behavior when no takeover lock is active', async () => {
    const actMock = vi.fn(async () => ({ ok: true, steps: [] }));
    const fakeAgent = { act: actMock } as unknown as AppAgent;
    const res = await runAgentAct({ steps: [{ ref: 'c1', action: 'press' }] }, { agent: fakeAgent });
    expect(res).toEqual({ ok: true, steps: [] });
    expect(actMock).toHaveBeenCalledTimes(1);
  });

  it('allows browser-trusted submit triggered by programmatic click on <button type="submit"> during takeover while blocking standalone trusted submit', () => {
    const owner = new AbortController();
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });

    // Simulate Chromium/HTML spec: browser's default activation of programmatic `button.click()`
    // dispatches a `submit` event whose `isTrusted` is true.
    const markSubmitTrusted = (event: Event) => {
      makeTrustedEvent(event);
    };
    window.addEventListener('submit', markSubmitTrusted, true);

    try {
      render(
        <div>
          <main id="main">
            <form id="create-profile-form" onSubmit={onSubmit}>
              <input aria-label="名称" defaultValue="test" />
            </form>
            <button type="submit" form="create-profile-form">
              创建并打开
            </button>
          </main>
          <AgentHost />
        </div>,
      );

      act(() => {
        acquireTakeover(owner, { activityLabel: '点击 创建并打开' });
      });

      // 1. Standalone trusted submit (not caused by an agent's programmatic click) must stay blocked.
      const form = document.getElementById('create-profile-form') as HTMLFormElement;
      const standaloneSubmit = makeTrustedEvent(new Event('submit', { bubbles: true, cancelable: true }));
      act(() => {
        form.dispatchEvent(standaloneSubmit);
      });
      expect(standaloneSubmit.defaultPrevented).toBe(true);
      expect(onSubmit).toHaveBeenCalledTimes(0);

      // 2. Programmatic click on `<button type="submit" form="...">` (untrusted click -> trusted submit) must run onSubmit.
      const submitBtn = screen.getByRole('button', { name: '创建并打开' });
      act(() => {
        submitBtn.click();
      });
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('submit', markSubmitTrusted, true);
      releaseTakeover(owner);
    }
  });
});
