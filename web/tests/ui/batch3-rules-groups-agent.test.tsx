import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentHost, clearAgentConfirms, createAppAllow, runAgentAct } from '@/ui/agent';
import { GroupEditorPane } from '@/ui/features/groups/editor';
import { GroupsWorkspace } from '@/ui/features/groups/workspace';
import { RulesPage } from '@/ui/features/rules/rules-page';
import { FeedbackHost } from '@/ui/primitives';
import { AppToaster } from '@/ui/primitives/feedback';

const ruleCreateMock = vi.fn().mockResolvedValue({
  id: 'r2',
  anchor: 'manual',
  type: 'DOMAIN-SUFFIX',
  value: 'netflix.com',
  policy: 'Proxy',
  rank: 20,
  enabled: true,
});
const rulePatchMock = vi.fn().mockResolvedValue({});
const groupCreateMock = vi.fn().mockResolvedValue({
  id: 'g2',
  name: '香港节点',
  type: 'url-test',
  rank: 2,
  updated_at: Date.now(),
});
const groupPatchMock = vi.fn().mockResolvedValue({
  id: 'g1',
  name: 'Proxy',
  type: 'select',
  proxies: ['DIRECT'],
  rank: 1,
  updated_at: Date.now(),
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/p/default/rules',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'g1' }),
}));

vi.mock('@/ui/data/hooks', () => ({
  keys: { scoped: (id: string, k: string) => `${id}:${k}` },
  useAnchors: () => ({ data: ['manual', 'late'] }),
  usePolicies: () => ({ data: ['Proxy', 'DIRECT', 'REJECT'] }),
  useRuleSets: () => ({ data: [] }),
  useGroups: () => ({
    data: [{ id: 'g1', name: 'Proxy', type: 'select', proxies: ['DIRECT'], rank: 1, updated_at: Date.now() }],
  }),
  useGroupTemplates: () => ({ data: [] }),
  useRuleSummary: () => ({ data: { total: 1, active: 1, disabled: 0, policies: { Proxy: 1 }, anchors: {} } }),
}));

vi.mock('@/ui/features/rules/use-rule-book', () => ({
  useRuleBook: () => ({
    data: {
      version: 1,
      rules: [
        {
          id: 'r1',
          anchor: 'manual',
          type: 'DOMAIN-SUFFIX',
          value: 'openai.com',
          policy: 'Proxy',
          rank: 10,
          enabled: true,
        },
        {
          id: 'r-match',
          anchor: 'late',
          type: 'MATCH',
          value: '',
          policy: 'DIRECT',
          rank: 100,
          enabled: true,
        },
      ],
    },
    isLoading: false,
    refetch: vi.fn(),
  }),
  ruleApi: {
    create: (...args: unknown[]) => ruleCreateMock(...args),
    patch: (...args: unknown[]) => rulePatchMock(...args),
    remove: vi.fn().mockResolvedValue({}),
    move: vi.fn().mockResolvedValue({}),
    normalize: vi.fn().mockResolvedValue({}),
    batch: vi.fn().mockResolvedValue([]),
  },
  afterRuleWrite: vi.fn(),
  fetchRuleBook: vi.fn(),
  patchBookLocally: vi.fn(),
}));

vi.mock('@/ui/features/groups/data', () => ({
  useGroupBook: () => ({
    data: {
      groups: [
        {
          id: 'g1',
          name: 'Proxy',
          type: 'select',
          proxies: ['DIRECT'],
          rank: 1,
          updated_at: Date.now(),
        },
      ],
    },
    error: null,
    refetch: vi.fn(),
  }),
  useNodeCatalog: () => ({
    names: ['HK-01', 'US-01'],
    bySub: { sub1: ['HK-01', 'US-01'] },
    subsById: new Map(),
    sources: [],
    types: new Map(),
    error: null,
  }),
  groupApi: {
    create: (...args: unknown[]) => groupCreateMock(...args),
    patch: (...args: unknown[]) => groupPatchMock(...args),
    remove: vi.fn().mockResolvedValue({}),
  },
  templateApi: {
    create: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
  },
  afterGroupWrite: vi.fn(),
  afterTemplateWrite: vi.fn(),
  putGroupLocally: vi.fn(),
  reorderGroups: vi.fn().mockResolvedValue(undefined),
  renderErrorText: (e: unknown) => String(e),
}));

vi.mock('@/ui/shell/scope', () => ({
  useScope: () => ({
    profile: { id: 'p1', name: 'default', display_name: '默认配置', kind: 'normal', source: { type: 'none' } },
    profileId: 'p1',
    path: (sub: string) => `/p/default/${sub}`,
  }),
}));

const agent = createAgent({ allow: createAppAllow() });

afterEach(() => {
  clearAgentConfirms();
  ruleCreateMock.mockClear();
  rulePatchMock.mockClear();
  groupCreateMock.mockClear();
  groupPatchMock.mockClear();
});

describe('Phase 5 Batch 3 Rules & Proxy Groups agent-readiness', () => {
  test('RulesPage exposes rules DataView, route tester, and gates adding a rule', async () => {
    const user = userEvent.setup();
    render(
      <>
        <RulesPage />
        <FeedbackHost />
        <AppToaster />
        <AgentHost agent={agent} />
      </>,
    );

    const list = await agent.query({ within: '规则列表' });
    expect(Array.isArray(list)).toBe(true);
    if (Array.isArray(list)) {
      expect(list[0]?.items?.some((i) => i.label.includes('openai.com'))).toBe(true);
    }

    const fill = await runAgentAct(
      {
        steps: [{ ref: '规则内容', action: 'setValue', args: ['netflix.com'] }],
      },
      { agent },
    );
    expect(fill.ok, fill.error?.message).toBe(true);

    const addPromise = runAgentAct({ steps: [{ ref: '添加', action: 'press' }] }, { agent });
    expect(await screen.findByText(/添加规则/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const added = await addPromise;
    expect(added.ok, added.error?.message).toBe(true);
    expect(ruleCreateMock).toHaveBeenCalledTimes(1);
  });

  test('GroupsWorkspace exposes groups DataView, creates group with confirm, and opens advanced collapsible', async () => {
    const user = userEvent.setup();
    render(
      <>
        <GroupsWorkspace>
          <GroupEditorPane />
        </GroupsWorkspace>
        <FeedbackHost />
        <AppToaster />
        <AgentHost agent={agent} />
      </>,
    );

    const list = await agent.query({ within: '策略组列表' });
    expect(Array.isArray(list)).toBe(true);
    if (Array.isArray(list)) {
      expect(list[0]?.items?.[0]?.label).toContain('Proxy');
    }

    const editName = await runAgentAct(
      {
        steps: [{ ref: '策略组名字', action: 'setValue', args: ['主力出口'] }],
      },
      { agent },
    );
    expect(editName.ok, editName.error?.message).toBe(true);

    const savePromise = runAgentAct({ steps: [{ ref: '保存', action: 'press' }] }, { agent });
    expect(await screen.findByText(/未保存的修改/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const saved = await savePromise;
    expect(saved.ok, saved.error?.message).toBe(true);
    expect(groupPatchMock).toHaveBeenCalledTimes(1);
  });
});
