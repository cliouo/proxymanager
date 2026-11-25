import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentHost, clearAgentConfirms, createAppAllow, runAgentAct } from '@/ui/agent';
import { BaseEditor } from '@/ui/features/base/base-editor';
import { ProfilesPage } from '@/ui/features/profiles/profiles';
import { RuleSetsView } from '@/ui/features/rule-sets/rule-sets-view';
import { FeedbackHost } from '@/ui/primitives';
import { AppToaster } from '@/ui/primitives/feedback';

const apiPostMock = vi.fn().mockResolvedValue({
  id: 'p2',
  name: 'travel',
  display_name: '出差配置',
  kind: 'normal',
  source: { type: 'none' },
});
const apiPutMock = vi.fn().mockResolvedValue({
  etag: 'etag-2',
  anchors: ['manual'],
  policies: ['DIRECT'],
  updated_at: Date.now(),
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/profiles',
}));

vi.mock('@/ui/data/api', async () => {
  const actual = await vi.importActual<typeof import('@/ui/data/api')>('@/ui/data/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      post: (...args: unknown[]) => apiPostMock(...args),
      put: (...args: unknown[]) => apiPutMock(...args),
      del: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
    },
    request: vi.fn().mockResolvedValue({ data: { valid: true, orphans: [], policies: ['DIRECT', 'Proxy'] } }),
  };
});

vi.mock('@/ui/data/hooks', () => ({
  keys: {
    profiles: 'profiles',
    scoped: (id: string, k: string) => `${id}:${k}`,
  },
  useProfiles: () => ({
    data: [{ id: 'p1', name: 'default', display_name: '默认配置', kind: 'normal', source: { type: 'none' } }],
    isLoading: false,
    isValidating: false,
    error: null,
    refetch: vi.fn(),
  }),
  useGroups: () => ({ data: [{ id: 'g1', name: 'Proxy', rank: 0 }], isLoading: false }),
  useRuleSummary: () => ({
    data: { total: 1, active: 1, disabled: 0, policies: { Proxy: 1 }, anchors: { manual: { active: 1, total: 1 } } },
    isLoading: false,
  }),
  useDevices: () => ({ data: [], isLoading: false }),
  useSources: () => ({ data: [], isLoading: false }),
  usePools: () => ({ data: [], isLoading: false }),
  useAllRules: () => ({ data: [], isLoading: false }),
  useMeta: () => ({ data: { ruleProvidersBase: 'https://example.com/rp' }, isLoading: false }),
  usePolicies: () => ({ data: ['DIRECT', 'Proxy'], isLoading: false }),
  useRuleSets: () => ({
    data: [
      {
        id: 'rs1',
        name: 'cn-direct',
        source: 'local',
        format: 'text',
        behavior: 'domain',
        note: '国内直连',
      },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRuleSet: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useBase: () => ({
    data: {
      content: 'mixed-port: 7890\n# === PROXY-GROUPS ===\nrules:\n  # === ANCHOR: manual ===\n',
      etag: 'etag-1',
      anchors: ['manual'],
      policies: ['DIRECT', 'Proxy'],
      updated_at: Date.now() - 10_000,
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  refreshProfile: vi.fn(),
  refreshProfiles: vi.fn(),
  refreshShared: vi.fn(),
}));

vi.mock('@/ui/shell/scope', () => ({
  useActiveProfile: () => ({ id: 'p1', name: 'default', display_name: '默认配置', kind: 'normal', source: { type: 'none' } }),
  useScope: () => ({
    profile: { id: 'p1', name: 'default', display_name: '默认配置', kind: 'normal', source: { type: 'none' } },
    profileId: 'p1',
    path: (sub: string) => `/p/default/${sub}`,
  }),
  profilePath: (name: string) => `/p/${name}`,
  lastProfileName: () => 'default',
  rememberProfile: vi.fn(),
}));

const agent = createAgent({ allow: createAppAllow() });

afterEach(() => {
  clearAgentConfirms();
  apiPostMock.mockClear();
  apiPutMock.mockClear();
});

describe('Phase 5 Batch 2 pages agent-readiness', () => {
  test('ProfilesPage exposes profiles DataView and gates creating a profile', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ProfilesPage />
        <FeedbackHost />
        <AppToaster />
        <AgentHost agent={agent} />
      </>,
    );

    const list = await agent.query({ within: '配置文件列表' });
    expect(Array.isArray(list)).toBe(true);
    if (Array.isArray(list)) {
      expect(list[0]?.items?.[0]?.label).toContain('默认配置');
    }

    const open = await runAgentAct({ steps: [{ ref: '新建配置文件', action: 'press' }] }, { agent });
    expect(open.ok, open.error?.message).toBe(true);

    const fill = await runAgentAct(
      {
        steps: [
          { ref: '显示名称', action: 'setValue', args: ['出差配置'] },
          { ref: '标识', action: 'setValue', args: ['travel'] },
        ],
      },
      { agent },
    );
    expect(fill.ok, fill.error?.message).toBe(true);

    const submitPromise = runAgentAct({ steps: [{ ref: '创建并打开', action: 'press' }] }, { agent });
    expect(await screen.findByText(/创建配置文件「.*」并打开/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const created = await submitPromise;
    expect(created.ok, created.error?.message).toBe(true);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  test('RuleSetsView exposes rule-sets DataView and filter controls', async () => {
    render(<RuleSetsView />);

    const list = await agent.query({ within: '规则集列表' });
    expect(Array.isArray(list)).toBe(true);
    if (Array.isArray(list)) {
      expect(list[0]?.items?.[0]?.label).toContain('cn-direct');
    }

    const filter = await runAgentAct(
      {
        steps: [{ ref: '搜索规则集', action: 'setValue', args: ['cn-direct'] }],
      },
      { agent },
    );
    expect(filter.ok, filter.error?.message).toBe(true);
  });

  test('BaseEditor exposes YAML editor, inspector DataViews, and gates saving base YAML', async () => {
    const user = userEvent.setup();
    render(
      <>
        <BaseEditor />
        <AppToaster />
        <AgentHost agent={agent} />
      </>,
    );

    const anchors = await agent.query({ within: '锚点与注入点' });
    expect(Array.isArray(anchors)).toBe(true);
    if (Array.isArray(anchors)) {
      expect(anchors[0]?.items?.some((item) => item.label.includes('manual'))).toBe(true);
    }

    const edit = await runAgentAct(
      {
        steps: [
          {
            ref: '基础配置 YAML',
            action: 'setValue',
            args: ['mixed-port: 7891\n# === PROXY-GROUPS ===\nrules:\n  # === ANCHOR: manual ===\n'],
          },
        ],
      },
      { agent },
    );
    expect(edit.ok, edit.error?.message).toBe(true);

    const savePromise = runAgentAct({ steps: [{ ref: '保存', action: 'press' }] }, { agent });
    expect(await screen.findByText('保存基础配置 YAML')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const saved = await savePromise;
    expect(saved.ok, saved.error?.message).toBe(true);
    expect(apiPutMock).toHaveBeenCalledTimes(1);
  });
});
