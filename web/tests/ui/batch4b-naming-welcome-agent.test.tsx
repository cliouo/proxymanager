import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { AppToaster, FeedbackHost } from '@/ui/primitives/feedback';
import { runAgentAct } from '@/ui/agent';
import type { NamingWorkspaceData } from '@/ui/features/naming/model';
import type { SetupApiStatus } from '@/ui/data/types';

const routerPush = vi.fn();
const routerReplace = vi.fn();
const mockApiPost = vi.fn();
const mockApplyPlan = vi.fn();
const mockMutateWs = vi.fn();

const WORKSPACE_DATA: NamingWorkspaceData = {
  entity: { type: 'subscription', ref: 'sub:s1', label: '机场 A' },
  aggregate: false,
  configVersion: 3,
  recommended: '${flag} ${region} ${index:2}',
  managed: {
    present: true,
    disabled: false,
    template: '${flag} ${region} ${index:2}',
    tw2cn: false,
    sourceAliases: {},
    recognitionRules: [],
    nodeFacts: {},
  },
  priorPlan: { present: false, createdGroups: [] },
  references: { consumingProfiles: [{ id: 'p1', name: 'default' }], orphaned: [] },
  health: [
    {
      sourceKey: 's1',
      sourceLabel: '机场 A',
      nodeCount: 2,
      ambiguousCount: 0,
      nodeFacts: [],
      nodeFactsTotal: 0,
      nodeFactsTruncated: false,
      unavailable: [],
      partial: [],
      fields: [
        {
          field: 'region',
          label: '地区',
          present: 2,
          total: 2,
          percent: 100,
          confidence: { high: 2, medium: 0, low: 0 },
          samples: [{ value: 'HK', count: 2, kind: 'intrinsic', confidence: 'high' }],
          sampleTruncated: false,
          sampleTotal: 1,
        },
      ],
      drift: [],
    },
  ],
  diagnostics: {
    nodeCount: 2,
    infoFiltered: 0,
    changed: 2,
    collisions: [],
    deduped: [],
    beforeNames: ['香港 1', '香港 2'],
    afterNames: ['🇭🇰 香港 01', '🇭🇰 香港 02'],
    truncated: false,
    memberWarnings: [],
  },
};

const SETUP_STATUS: SetupApiStatus = {
  state: 'empty',
  can_bootstrap: true,
  revision: 1,
  starter_version: 'starter-v1',
  reason_codes: [],
  inventory: {
    profiles_total: 0,
    profiles_valid: 0,
    profiles_invalid: 0,
    default_profile_id: null,
    has_base: false,
    base_content_present: false,
    base_meta_present: false,
    proxy_groups_total: 0,
    proxy_groups_invalid: 0,
    rules_total: 0,
    rules_invalid: 0,
    source_type: null,
  },
  provenance: null,
  diagnostics: [],
  starter: {
    profile_name: 'default',
    listener_ports: 'client-managed',
    allow_lan: false,
    mode: 'rule',
    log_level: 'info',
    dns_enabled: false,
    tun_enabled: false,
    sniffer_enabled: false,
    rule_sets_total: 0,
    final_rule: 'MATCH,默认',
    proxy_groups: [
      { name: '自动选择', type: 'url-test' },
      { name: '默认', type: 'select' },
    ],
  },
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  useParams: () => ({ id: 's1' }),
}));

vi.mock('@/ui/data/api', async () => {
  const actual = await vi.importActual<typeof import('@/ui/data/api')>('@/ui/data/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      post: (...args: unknown[]) => mockApiPost(...args),
    },
    request: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@/ui/data/hooks', () => ({
  keys: { profiles: 'profiles', setup: 'setup' },
  refreshShared: vi.fn(),
  useSetupStatus: () => ({ data: SETUP_STATUS, isLoading: false, isValidating: false, error: null, refetch: vi.fn() }),
}));

vi.mock('@/ui/data/query', async () => {
  const actual = await vi.importActual<typeof import('@/ui/data/query')>('@/ui/data/query');
  return {
    ...actual,
    invalidate: vi.fn(),
    setQueryData: vi.fn(),
    useQuery: (key: string | null) => {
      if (key?.includes(':candidates:')) {
        return {
          data: {
            configVersion: 3,
            groupingAvailable: false,
            candidates: [
              {
                id: 'compact',
                title: '精简方案',
                template: '${region_code} ${index:2}',
                sample: ['HK 01', 'HK 02'],
                groups: [],
                emptiedGroups: [],
                references: [],
                warnings: [],
                blocked: false,
              },
            ],
          },
          isLoading: false,
          isValidating: false,
          error: null,
        };
      }
      return { data: undefined, isLoading: false, isValidating: false, error: null };
    },
  };
});

vi.mock('@/ui/features/naming/data', () => ({
  applyPlan: (...args: unknown[]) => mockApplyPlan(...args),
  isVersionConflict: () => false,
  rollbackPlan: vi.fn(),
  disablePlan: vi.fn(),
  recognizeNodeFacts: vi.fn(),
  useCurrentNames: () => ({ data: { names: ['香港 1', '香港 2'], operators: [] }, isLoading: false }),
  useDebounced: <T,>(v: T) => v,
  useNamingPreview: () => ({
    data: {
      candidate: { index: 0, mode: 'replaced' },
      after: { count: 2, names: ['🇭🇰 香港 01', '🇭🇰 香港 02'], truncated: false },
      infoFiltered: 0,
      issues: [],
    },
    isValidating: false,
    error: null,
  }),
  useNamingWorkspace: () => ({ data: WORKSPACE_DATA, error: null, mutate: mockMutateWs, refetch: vi.fn() }),
}));

import { NamingWorkspace } from '@/ui/features/naming/workspace';
import { WelcomePage } from '@/ui/features/welcome/welcome';

describe('Phase 5 Batch 4B Naming & Welcome agent-readiness', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__UI_SDK_STRICT__ = true;
    routerPush.mockReset();
    routerReplace.mockReset();
    mockApiPost.mockReset();
    mockApplyPlan.mockReset();
    mockMutateWs.mockReset();
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as Record<string, unknown>).__UI_SDK_STRICT__;
  });

  it('NamingWorkspace exposes preview/coverage/candidates DataViews and gates applying a candidate', async () => {
    mockApiPost.mockResolvedValue({ ...WORKSPACE_DATA, configVersion: 4 });
    const allow = vi.fn().mockResolvedValue(true);
    const agent = createAgent({ allow });

    render(
      <>
        <NamingWorkspace type="subscription" />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    const snapText = () => JSON.stringify(agent.snapshot());
    expect(snapText()).toContain('推荐命名方案');
    expect(snapText()).toContain('改名预览列表');
    expect(snapText()).toContain('字段识别覆盖率');

    // Expand recognition rules collapsible
    await runAgentAct({ steps: [{ ref: '识别规则', action: 'toggle' }] }, { agent });
    await waitFor(() => expect(snapText()).toContain('添加规则'));

    // Apply candidate (directly writes to server -> gated by data-agent-confirm)
    const res = await runAgentAct({ steps: [{ ref: '应用「精简方案」', action: 'press' }] }, { agent });
    expect(res.ok).toBe(true);
    expect(allow.mock.calls.some(([step]) => Boolean(step.confirm))).toBe(true);
    expect(mockApiPost).toHaveBeenCalledWith(
      '/naming/subscription/s1',
      expect.objectContaining({
        apply: { template: '${region_code} ${index:2}' },
        expectedVersion: 3,
      }),
    );
  });

  it('WelcomePage exposes initialization DataView and gates bootstrap', async () => {
    mockApiPost.mockResolvedValue({
      created: true,
      profile: { id: 'p1', name: 'default' },
      resources: { proxy_group_ids: ['g1'], rule_ids: ['r1'] },
    });
    const allow = vi.fn().mockResolvedValue(true);
    const agent = createAgent({ allow });

    render(
      <>
        <WelcomePage />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    const snapText = () => JSON.stringify(agent.snapshot());
    expect(snapText()).toContain('工作区初始化状态');
    expect(snapText()).toContain('初始化');

    const res = await runAgentAct({ steps: [{ ref: '初始化', action: 'press' }] }, { agent });
    expect(res.ok).toBe(true);
    expect(allow.mock.calls.some(([step]) => Boolean(step.confirm))).toBe(true);
    expect(mockApiPost).toHaveBeenCalledWith(
      '/setup/bootstrap',
      expect.objectContaining({ expected_revision: 1, starter_version: 'starter-v1' }),
    );
  });
});
