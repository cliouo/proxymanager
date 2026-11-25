import { useEffect, useState } from 'react';
import { render } from '@testing-library/react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { createAgent } from '@ui-sdk/react/agent';
import { Input as UiInput } from '@ui-sdk/react/input';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clearAgentConfirms,
  createAppAllow,
  DataView,
  resolveAgentConfirm,
  usePendingAgentConfirm,
} from '@/ui/agent';
import {
  dispatchAgentTool,
  runAgent,
  toOpenAiTools,
  type AgentEvent,
} from '@/ui/assistant/agent';
import { describeInput, describeResult, resultError } from '@/ui/assistant/labels';
import { buildSystemPrompt, pageLabelFor } from '@/ui/assistant/prompt';
import { getActiveRequestSource } from '@/ui/data/api';
import type { AssistantConfig } from '@/ui/data/types';

function makeSseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function AutoConfirm({ approve }: { approve: boolean }) {
  const pending = usePendingAgentConfirm();
  useEffect(() => {
    if (pending) resolveAgentConfirm(pending.id, approve);
  }, [pending, approve]);
  return null;
}

const TEST_CONFIG: AssistantConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-secret-12345678',
  model: 'deepseek-chat',
  thinking: 'disabled',
  reasoningEffort: 'medium',
  maxTokens: 2048,
};

afterEach(() => {
  clearAgentConfirms();
  vi.restoreAllMocks();
});

describe('In-site assistant agentTools loop', () => {
  test('toOpenAiTools exposes snapshot, query, and act schemas', () => {
    const tools = toOpenAiTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['act', 'query', 'snapshot']));
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeTypeOf('object');
    }
  });

  test('buildSystemPrompt includes current page, profile, and navigation map', () => {
    expect(pageLabelFor('/sources')).toBe('节点来源');
    expect(pageLabelFor('/p/default/rules')).toBe('规则');
    expect(pageLabelFor('/p/default')).toBe('总览');

    const prompt = buildSystemPrompt({
      pathname: '/p/default/groups',
      profile: { id: 'p1', name: 'default', label: '主力配置' },
    });
    expect(prompt).toContain('策略组');
    expect(prompt).toContain('主力配置');
    expect(prompt).toContain('节点来源');
    expect(prompt).toContain('data-agent-confirm'.replace('data-agent-', ''));
  });

  test('dispatchAgentTool supports snapshot, query, confirm approval/refusal, and X-Source', async () => {
    const agent = createAgent({ allow: createAppAllow() });
    let savedValue = '';
    let capturedSource: string | null = null;

    function DemoForm({ approve }: { approve: boolean }) {
      const [name, setName] = useState('初始值');
      return (
        <div>
          <AutoConfirm approve={approve} />
          <UiInput aria-label="订阅名称" value={name} onValueChange={setName} />
          <UiButton
            data-agent-confirm="保存订阅名称"
            onClick={() => {
              savedValue = name;
              capturedSource = getActiveRequestSource();
            }}
          >
            保存
          </UiButton>
          <DataView
            label="订阅源列表"
            summary="共 2 个订阅源"
            items={[
              { value: 's1', label: '机场 A · 10 个节点' },
              { value: 's2', label: '机场 B · 20 个节点' },
            ]}
          >
            <div>list</div>
          </DataView>
        </div>
      );
    }

    const { rerender } = render(<DemoForm approve={true} />);

    const snap = await dispatchAgentTool('snapshot', {}, { agent });
    expect(snap.kind).toBe('snapshot');
    expect(describeResult(snap.kind, snap.data)).toContain('个控件');

    const queried = await dispatchAgentTool('query', { within: '订阅源列表', text: '机场 B' }, { agent });
    expect(queried.kind).toBe('query');
    expect(describeInput('query', { within: '订阅源列表', text: '机场 B' })).toContain('订阅源列表');
    expect(describeResult(queried.kind, queried.data)).toBe('1 项');

    const acted = await dispatchAgentTool(
      'act',
      {
        steps: [
          { ref: '订阅名称', action: 'setValue', args: ['新订阅'] },
          { ref: '保存', action: 'press' },
        ],
      },
      { agent },
    );
    expect(acted.kind).toBe('act');
    expect(savedValue).toBe('新订阅');
    expect(capturedSource).toBe('ai_chat');
    expect(describeResult(acted.kind, acted.data)).toBe('2 步完成');

    rerender(<DemoForm approve={false} />);
    savedValue = '';
    const refused = await dispatchAgentTool('act', { steps: [{ ref: '保存', action: 'press' }] }, { agent });
    expect(refused.kind).toBe('error');
    expect(savedValue).toBe('');
    expect(resultError(refused.data)).toBeTruthy();
  });

  test('runAgent executes multi-round SSE tool calls end-to-end against rendered ui-sdk controls', async () => {
    const agent = createAgent({ allow: createAppAllow() });
    let submitted = '';
    let sourceDuringSubmit: string | null = null;

    function MiniPage() {
      const [val, setVal] = useState('');
      return (
        <div>
          <AutoConfirm approve={true} />
          <UiInput aria-label="规则内容" value={val} onValueChange={setVal} />
          <UiButton
            data-agent-confirm="提交规则"
            onClick={() => {
              submitted = val;
              sourceDuringSubmit = getActiveRequestSource();
            }}
          >
            提交
          </UiButton>
        </div>
      );
    }

    render(<MiniPage />);

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeSseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call_snap', function: { name: 'snapshot', arguments: '{}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_act',
                      function: {
                        name: 'act',
                        arguments: JSON.stringify({
                          steps: [
                            { ref: '规则内容', action: 'setValue', args: ['DOMAIN,netflix.com,Proxy'] },
                            { ref: '提交', action: 'press' },
                          ],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          { choices: [{ delta: { content: '已经帮你提交规则。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      );

    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const status = await runAgent({
      config: TEST_CONFIG,
      system: buildSystemPrompt({ pathname: '/p/default/rules', profile: { id: 'p1', name: 'default', label: '默认' } }),
      messages: [{ role: 'user', content: '添加 netflix 规则' }],
      signal: controller.signal,
      agent,
      onEvent: (event) => events.push(event),
    });

    expect(status).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(submitted).toBe('DOMAIN,netflix.com,Proxy');
    expect(sourceDuringSubmit).toBe('ai_chat');
    expect(events.some((e) => e.type === 'tool-result' && e.name === 'snapshot' && e.result.kind === 'snapshot')).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'tool-result' && e.name === 'act' && e.result.kind === 'act')).toBe(true);
    expect(events.some((e) => e.type === 'content' && e.text.includes('已经帮你提交规则'))).toBe(true);
  });

  test('snapshot stays non-blocking and appends loading hint only when #main has skeletons', async () => {
    const agent = createAgent({ allow: createAppAllow() });
    const { container } = render(
      <main id="main">
        <UiButton onClick={() => undefined}>新建配置文件</UiButton>
        <div className="skeleton" />
      </main>,
    );

    const loadingSnap = await dispatchAgentTool('snapshot', {}, { agent });
    expect(loadingSnap.kind).toBe('snapshot');
    expect(Array.isArray(loadingSnap.data)).toBe(true);
    const parsedLoading = JSON.parse(loadingSnap.modelContent) as { loading?: boolean; components?: unknown[] };
    expect(parsedLoading.loading).toBe(true);
    expect(Array.isArray(parsedLoading.components)).toBe(true);

    container.querySelector('.skeleton')?.remove();
    const readySnap = await dispatchAgentTool('snapshot', {}, { agent });
    expect(Array.isArray(JSON.parse(readySnap.modelContent))).toBe(true);
  });
});
