import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentHost, clearAgentConfirms, createAppAllow, runAgentAct } from '@/ui/agent';
import { HistoryPage } from '@/ui/features/history/history';
import { OutputView } from '@/ui/features/output/output-view';
import { SettingsPage } from '@/ui/features/settings/settings';
import { FeedbackHost } from '@/ui/primitives';
import { AppToaster } from '@/ui/primitives/feedback';

const apiPutMock = vi.fn().mockResolvedValue({
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-saved',
  thinking: 'enabled',
  reasoningEffort: 'medium',
  maxTokens: 4096,
});
const apiPostMock = vi.fn().mockResolvedValue({});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings',
}));

vi.mock('next-themes', async () => {
  const React = await import('react');
  return {
    useTheme: () => {
      const [theme, setTheme] = React.useState('system');
      return { theme, setTheme };
    },
  };
});

vi.mock('@/ui/data/api', async () => {
  const actual = await vi.importActual<typeof import('@/ui/data/api')>('@/ui/data/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      put: (...args: unknown[]) => apiPutMock(...args),
      post: (...args: unknown[]) => apiPostMock(...args),
    },
    clearAdminKey: vi.fn(),
    request: vi.fn().mockResolvedValue({
      status: 'ok',
      checks: { redis: { ok: true } },
      uptime_seconds: 3600,
      timestamp: new Date().toISOString(),
      build_id: 'b123',
    }),
  };
});

vi.mock('@/ui/data/hooks', () => ({
  keys: { assistantConfig: 'assistant:config' },
  useAssistantConfig: () => ({
    data: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'sk-secret-key-9999',
      thinking: 'enabled',
      reasoningEffort: 'high',
      maxTokens: 8192,
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMeta: () => ({
    data: { subBase: 'https://example.com/api/sub/super-secret-token' },
    isLoading: false,
    error: null,
  }),
  useProfiles: () => ({
    data: [{ id: 'p1', name: 'default', display_name: '默认配置', kind: 'profile' }],
  }),
  useSources: () => ({ data: [{ id: 's1', name: 'sub-a', display_name: '机场 A' }] }),
  usePools: () => ({ data: [] }),
  usePreview: () => ({
    data: {
      build_id: 'b777',
      rendered_at: Date.now(),
      content: 'mixed-port: 7890\nproxies:\n  - name: HK-01\nrules:\n  - MATCH,DIRECT\n',
      inlined_proxy_count: 1,
      proxy_group_count: 2,
      anchors_applied: [{ anchor: 'manual', ruleCount: 3 }],
      subscriptions: [{ name: 'sub-a', stale: false }],
      nodes_by_sub: { 'sub-a': ['HK-01'] },
      warnings: [],
      collisions: [],
      unmatched_anchors: [],
    },
    isLoading: false,
    isValidating: false,
    error: null,
    refetch: vi.fn(),
  }),
  refreshProfile: vi.fn(),
  refreshShared: vi.fn(),
}));

vi.mock('@/ui/data/query', async () => {
  const actual = await vi.importActual<typeof import('@/ui/data/query')>('@/ui/data/query');
  return {
    ...actual,
    setQueryData: vi.fn(),
    clearQueries: vi.fn(),
    useQuery: (key: string) => {
      if (key === 'settings:health') {
        return {
          data: {
            status: 'ok',
            checks: { redis: { ok: true } },
            uptime_seconds: 3600,
            timestamp: new Date().toISOString(),
            build_id: 'b123',
          },
          isLoading: false,
          isValidating: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      return {
        data: {
          data: [
            {
              id: 'ev-1',
              ts: Date.now() - 60_000,
              op: 'rule.create',
              actor: 'ai_chat',
              scope: 'profile',
              profileId: 'p1',
              undoable: true,
              target: { kind: 'rule', name: 'netflix.com' },
            },
          ],
          meta: { nextCursor: null },
        },
        isLoading: false,
        isValidating: false,
        error: null,
        refetch: vi.fn(),
      };
    },
  };
});

vi.mock('@/ui/shell/scope', () => ({
  useActiveProfile: () => ({ id: 'p1', name: 'default', display_name: '默认配置', kind: 'profile' }),
  useScope: () => ({
    profile: { id: 'p1', name: 'default', display_name: '默认配置', kind: 'profile' },
    profileId: 'p1',
    path: (sub: string) => `/p/default/${sub}`,
  }),
  profilePath: (name: string) => `/p/${name}`,
}));

const agent = createAgent({ allow: createAppAllow() });

afterEach(() => {
  clearAgentConfirms();
  apiPutMock.mockClear();
  apiPostMock.mockClear();
});

describe('Phase 5 Batch 1 pages agent-readiness', () => {
  test('SettingsPage redacts API Key, reads service health, and gates saving AI settings', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SettingsPage />
        <AppToaster />
        <AgentHost agent={agent} />
      </>,
    );

    const health = await agent.query({ within: '连接与服务状态' });
    expect(Array.isArray(health)).toBe(true);
    if (Array.isArray(health)) {
      const items = health[0]?.items ?? [];
      expect(items.some((item) => item.label.includes('Redis 已连接'))).toBe(true);
      expect(JSON.stringify(health)).not.toContain('super-secret-token');
    }

    const res = await runAgentAct(
      {
        steps: [
          { ref: '模型', action: 'setValue', args: ['deepseek-chat'] },
          { ref: '思考强度', action: 'setValue', args: ['中'] },
        ],
      },
      { agent },
    );
    expect(res.ok, res.error?.message).toBe(true);

    const savePromise = runAgentAct({ steps: [{ ref: '保存', action: 'press' }] }, { agent });
    expect(await screen.findByText('保存 AI 助手设置')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const saved = await savePromise;
    expect(saved.ok, saved.error?.message).toBe(true);
    expect(apiPutMock).toHaveBeenCalledTimes(1);
  });

  test('HistoryPage exposes audit ledger via DataView and gates undo confirmation', async () => {
    const user = userEvent.setup();
    render(
      <>
        <HistoryPage />
        <FeedbackHost />
        <AppToaster />
        <AgentHost agent={agent} />
      </>,
    );

    const ledger = await agent.query({ within: '操作历史列表' });
    expect(Array.isArray(ledger)).toBe(true);
    if (Array.isArray(ledger)) {
      expect(ledger[0]?.items?.[0]?.label).toContain('AI 助手');
    }

    const openConfirm = await runAgentAct({ steps: [{ ref: '撤销', action: 'press' }] }, { agent });
    expect(openConfirm.ok, openConfirm.error?.message).toBe(true);

    const undoPromise = runAgentAct(
      { steps: [{ ref: '撤销这条操作？', action: 'press', args: ['确认撤销'] }] },
      { agent },
    );
    expect(await screen.findByText(/撤销操作/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const undone = await undoPromise;
    expect(undone.ok, undone.error?.message).toBe(true);
    expect(apiPostMock).toHaveBeenCalledWith('/history/ev-1/undo');
  });

  test('OutputView exposes summary, diagnostics, sources, anchors, and read-only YAML', async () => {
    render(<OutputView />);

    const snap = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more');
    const labels = snap.map((e) => e.label);
    expect(labels).toContain('最终配置概要');
    expect(labels).toContain('渲染诊断');
    expect(labels).toContain('最终配置节点来源');
    expect(labels).toContain('规则锚点分布');
    expect(labels).toContain('最终配置 YAML');

    const yamlEntry = snap.find((e) => e.label === '最终配置 YAML');
    expect(yamlEntry?.value).toContain('mixed-port: 7890');
  });
});
