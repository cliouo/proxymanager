import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { Button } from '@ui-sdk/react/button';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AgentHost,
  agentTools,
  clearAgentConfirms,
  createAppAllow,
  runAgentAct,
} from '@/ui/agent';
import { request } from '@/ui/data/api';

const agent = createAgent({ allow: createAppAllow() });

afterEach(() => {
  clearAgentConfirms();
  vi.restoreAllMocks();
  delete (document as Document & { modelContext?: unknown }).modelContext;
});

describe('ui-sdk agent bridge foundation', () => {
  test('globals.css declares @layer ui-sdk before tailwind import', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    const layerIdx = css.indexOf('@layer ui-sdk;');
    const tailwindIdx = css.indexOf("@import 'tailwindcss';");
    expect(layerIdx).toBeGreaterThanOrEqual(0);
    expect(tailwindIdx).toBeGreaterThan(layerIdx);
  });

  test('exports agentTools with snapshot, act, and query', () => {
    const names = agentTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['snapshot', 'act', 'query']));
  });

  test('unmarked button runs immediately and sends X-Source: ai_chat', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(
      <>
        <Button onClick={() => void request('/subscriptions', { method: 'POST', body: {} })}>
          刷新列表
        </Button>
        <AgentHost agent={agent} />
      </>,
    );

    const snap = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more');
    expect(snap.map((e) => e.label)).toContain('刷新列表');
    expect(snap.every((e) => e.label !== 'AI 操作确认')).toBe(true);

    const result = await runAgentAct(
      { steps: [{ ref: '刷新列表', action: 'press' }] },
      { agent },
    );
    expect(result.ok, result.error?.message).toBe(true);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['X-Source']).toBe('ai_chat');
  });

  test('explicit X-Source header is preserved during agent act', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(
      <Button
        onClick={() =>
          void request('/subscriptions/1/manual-refresh', {
            method: 'POST',
            headers: { 'X-Source': 'web' },
          })
        }
      >
        手动导入
      </Button>,
    );

    const result = await runAgentAct(
      { steps: [{ ref: '手动导入', action: 'press' }] },
      { agent },
    );
    expect(result.ok, result.error?.message).toBe(true);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['X-Source']).toBe('web');
  });

  test('data-agent-confirm prompts once, stays hidden from snapshot, and obeys deny/approve', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(
      <>
        <Button data-agent-confirm="将永久删除该订阅源" onClick={onDelete}>
          永久删除
        </Button>
        <AgentHost agent={agent} />
      </>,
    );

    const deniedPromise = runAgentAct(
      { steps: [{ ref: '永久删除', action: 'press' }] },
      { agent },
    );

    expect(await screen.findByText('将永久删除该订阅源')).toBeTruthy();
    const openSnap = agent.snapshot().filter((e) => !e.offPage);
    expect(openSnap.some((e) => e.label === 'AI 操作确认')).toBe(false);

    await user.click(screen.getByRole('button', { name: '拒绝' }));
    const denied = await deniedPromise;
    expect(denied.ok).toBe(false);
    expect(onDelete).not.toHaveBeenCalled();

    const approvedPromise = runAgentAct(
      { steps: [{ ref: '永久删除', action: 'press' }] },
      { agent },
    );

    expect(await screen.findByText('将永久删除该订阅源')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const approved = await approvedPromise;
    expect(approved.ok, approved.error?.message).toBe(true);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test('aborting act signal closes the confirm dialog and rejects the step', async () => {
    const onSave = vi.fn();
    render(
      <>
        <Button data-agent-confirm="保存配置到服务端" onClick={onSave}>
          保存配置
        </Button>
        <AgentHost agent={agent} />
      </>,
    );

    const controller = new AbortController();
    const pending = runAgentAct(
      { steps: [{ ref: '保存配置', action: 'press' }] },
      { agent, signal: controller.signal },
    );

    expect(await screen.findByText('保存配置到服务端')).toBeTruthy();
    controller.abort();

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('保存配置到服务端')).toBeNull());
  });

  test('AgentHost registers WebMCP tools, asks once on confirm, tags X-Source: webmcp, and unregisters on unmount', async () => {
    const user = userEvent.setup();
    const tools = new Map<string, { name: string; execute: (input: object) => Promise<unknown> }>();
    const signals: AbortSignal[] = [];
    const unregisterTool = vi.fn((name: string) => {
      tools.delete(name);
    });

    Object.assign(document, {
      modelContext: {
        registerTool: async (
          tool: { name: string; execute: (input: object) => Promise<unknown> },
          options?: { signal?: AbortSignal },
        ) => {
          tools.set(tool.name, tool);
          if (options?.signal) {
            signals.push(options.signal);
            options.signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
          }
        },
        unregisterTool,
      },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { unmount } = render(
      <>
        <Button
          data-agent-confirm="应用当前修改"
          onClick={() => void request('/profiles', { method: 'POST', body: {} })}
        >
          应用修改
        </Button>
        <AgentHost agent={agent} />
      </>,
    );

    await waitFor(() => {
      expect(tools.has('snapshot')).toBe(true);
      expect(tools.has('act')).toBe(true);
      expect(tools.has('query')).toBe(true);
    });

    const snapshot = await tools.get('snapshot')!.execute({});
    expect(Array.isArray(snapshot)).toBe(true);

    const actPromise = tools.get('act')!.execute({
      steps: [{ ref: '应用修改', action: 'press' }],
    });

    expect(await screen.findByText('应用当前修改')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));

    const actResult = (await actPromise) as { ok: boolean };
    expect(actResult.ok).toBe(true);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['X-Source']).toBe('webmcp');

    unmount();
    const unregisteredViaSignal = signals.length > 0 && signals.every((s) => s.aborted);
    expect(unregisteredViaSignal || unregisterTool.mock.calls.length > 0).toBe(true);
  });
});
