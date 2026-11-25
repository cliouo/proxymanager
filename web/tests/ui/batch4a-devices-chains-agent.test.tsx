import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { AppToaster, FeedbackHost } from '@/ui/primitives/feedback';
import { runAgentAct } from '@/ui/agent';
import type { ChainSummary, ParsedConfig, Profile, ProxyGroup, PublicDevice } from '@/ui/data/types';

const routerPush = vi.fn();
const routerReplace = vi.fn();
const mockApiPost = vi.fn();
const mockApiPatch = vi.fn();
const mockApiPut = vi.fn();
const mockApiDel = vi.fn();
const mockApiGet = vi.fn();

const PROFILE: Profile = {
  id: 'p1',
  name: 'default',
  display_name: '默认配置',
  kind: 'normal',
  source: { type: 'none' },
  created_at: 1,
  updated_at: 1,
};

const DEVICE_1: PublicDevice = {
  id: 'd1',
  name: 'iphone',
  display_name: 'iPhone 16',
  notes: '主力机',
  base_patch: { 'find-process-mode': 'off' },
  features: {},
  created_at: 1,
  updated_at: 1,
};

const GROUPS: ProxyGroup[] = [
  { id: 'g1', name: '🚀 节点选择', type: 'select', kind: 'manual', rank: 1, updated_at: 1, proxies: ['HK-01', 'US-01'] },
  { id: 'g2', name: 'HK -> US', type: 'select', kind: 'manual', rank: 2, updated_at: 1, proxies: ['US-01'], 'dialer-proxy': 'HK-01' },
];

const CHAINS: ChainSummary = {
  fixedChains: [{ chainName: 'HK -> US', front: 'HK-01', backend: 'US-01' }],
  poolChains: [],
};

const PARSED: ParsedConfig = {
  proxies: [
    { name: 'HK-01', type: 'ss', server: '1.1.1.1' },
    { name: 'US-01', type: 'vmess', server: '2.2.2.2' },
  ],
  proxyGroups: [],
  etag: 'e1',
  updated_at: 1,
  resolve: {
    buildId: 'b1',
    inlinedProxyCount: 2,
    proxyGroupCount: 2,
    nodeNames: ['HK-01', 'US-01'],
    collisions: [],
    subscriptions: [],
    warnings: [],
  },
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('@/ui/data/api', async () => {
  const actual = await vi.importActual<typeof import('@/ui/data/api')>('@/ui/data/api');
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => mockApiGet(...args),
      post: (...args: unknown[]) => mockApiPost(...args),
      patch: (...args: unknown[]) => mockApiPatch(...args),
      put: (...args: unknown[]) => mockApiPut(...args),
      del: (...args: unknown[]) => mockApiDel(...args),
    },
  };
});

vi.mock('@/ui/data/hooks', () => ({
  keys: {
    scoped: (profileId: string, name: string) => `p:${profileId}:${name}`,
  },
  refreshProfile: vi.fn(),
  useDevices: () => ({ data: [DEVICE_1], isLoading: false, error: null, mutate: vi.fn(), refetch: vi.fn() }),
  useDevice: () => ({ data: DEVICE_1, isLoading: false, error: null, refetch: vi.fn() }),
  useDevicePreview: () => ({
    data: {
      shared: 'mixed-port: 7890\nfind-process-mode: strict\n',
      device: 'mixed-port: 7890\nfind-process-mode: off\n',
      issues: [],
    },
    isLoading: false,
    isValidating: false,
    error: null,
    refetch: vi.fn(),
  }),
  useDashboard: () => ({
    data: {
      meta: { subscriptionUrl: 'https://pm.example/api/sub/secret-token/default' },
      counts: { proxyGroups: 2, rules: 10 },
    },
    isLoading: false,
    error: null,
  }),
  useChains: () => ({ data: CHAINS, isLoading: false, error: null, refetch: vi.fn() }),
  useGroups: () => ({ data: GROUPS, isLoading: false, error: null, refetch: vi.fn() }),
  useParsed: () => ({ data: PARSED, isLoading: false, error: null, refetch: vi.fn() }),
  useRuleSummary: () => ({ data: { total: 10, policies: { 'HK -> US': 2 } }, isLoading: false, error: null }),
}));

vi.mock('@/ui/data/query', async () => {
  const actual = await vi.importActual<typeof import('@/ui/data/query')>('@/ui/data/query');
  return {
    ...actual,
    setQueryData: vi.fn(),
    useQuery: (key: string | null) => {
      if (key?.includes('device-ts-instances')) {
        return { data: { instances: [], warnings: [] }, isLoading: false, error: null, refetch: vi.fn(), mutate: vi.fn() };
      }
      if (key?.includes('device-ts:')) {
        return { data: { feature: null, warnings: [] }, isLoading: false, error: null, refetch: vi.fn(), mutate: vi.fn() };
      }
      return { data: undefined, isLoading: false, error: null, refetch: vi.fn(), mutate: vi.fn() };
    },
  };
});

vi.mock('@/ui/shell/scope', () => ({
  useScope: () => ({
    profile: PROFILE,
    profileId: PROFILE.id,
    path: (sub: string) => `/p/default/${sub}`,
  }),
}));

vi.mock('@/ui/editor/code-editor', () => ({
  CodeEditor: ({ value, label }: { value: string; label?: string }) => (
    <textarea aria-label={label ?? 'YAML'} value={value} readOnly />
  ),
}));

import { DevicesPage } from '@/ui/features/devices/devices-page';
import { DeviceEditor } from '@/ui/features/devices/device-editor';
import { ChainsPage } from '@/ui/features/chains/chains-page';

describe('Phase 5 Batch 4A Devices & Chains agent-readiness', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__UI_SDK_STRICT__ = true;
    routerPush.mockReset();
    routerReplace.mockReset();
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockApiPatch.mockReset();
    mockApiPut.mockReset();
    mockApiDel.mockReset();
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as Record<string, unknown>).__UI_SDK_STRICT__;
  });

  it('DevicesPage exposes devices DataView and gates creating a device', async () => {
    mockApiPost.mockResolvedValue({ ...DEVICE_1, id: 'd2', name: 'macbook', display_name: 'MacBook' });
    const allow = vi.fn().mockResolvedValue(true);
    const agent = createAgent({ allow });

    render(
      <>
        <DevicesPage />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    const snapText = () => JSON.stringify(agent.snapshot());
    expect(snapText()).toContain('设备列表');
    expect(snapText()).toContain('添加设备');

    // Open NewDeviceDialog
    await runAgentAct({ steps: [{ ref: '添加设备', action: 'press' }] }, { agent });
    await waitFor(() => expect(snapText()).toContain('设备预设'));

    // Fill display name and choose preset
    await runAgentAct(
      {
        steps: [
          { ref: '显示名称', action: 'setValue', args: ['MacBook'] },
          { ref: '设备预设', action: 'setValue', args: ['desktop'] },
        ],
      },
      { agent },
    );

    // Submit gated by data-agent-confirm
    const res = await runAgentAct({ steps: [{ ref: '确认添加设备', action: 'press' }] }, { agent });
    expect(res.ok).toBe(true);
    expect(allow.mock.calls.some(([step]) => Boolean(step.confirm))).toBe(true);
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith(
        '/profiles/p1/devices',
        expect.objectContaining({ name: 'macbook', display_name: 'MacBook' }),
      ),
    );
  });

  it('DeviceEditor exposes preview DataView, Tailscale collapsible, and redacts subscription token URL', async () => {
    mockApiPut.mockResolvedValue({ feature: { hostname: 'iphone', hasAuthKey: false, routeMode: 'cidr' }, warnings: [] });
    const allow = vi.fn().mockResolvedValue(true);
    const agent = createAgent({ allow });

    render(
      <>
        <DeviceEditor deviceId="d1" />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    const snapText = () => JSON.stringify(agent.snapshot());
    expect(snapText()).toContain('设备生效预览');
    expect(snapText()).toContain('启用 Tailscale');
    expect(snapText()).not.toContain('secret-token');

    // Enable Tailscale form, expand advanced settings, and submit with confirm
    await runAgentAct({ steps: [{ ref: '启用 Tailscale', action: 'press' }] }, { agent });
    await waitFor(() => expect(snapText()).toContain('启用并保存'));

    await runAgentAct({ steps: [{ ref: '高级设置', action: 'press' }] }, { agent });
    await waitFor(() => expect(snapText()).toContain('控制服务器'));

    const res = await runAgentAct({ steps: [{ ref: '启用并保存', action: 'press' }] }, { agent });
    expect(res.ok).toBe(true);
    expect(allow.mock.calls.some(([step]) => Boolean(step.confirm))).toBe(true);
    expect(mockApiPut).toHaveBeenCalledWith(
      '/profiles/p1/devices/d1/features/tailscale',
      expect.objectContaining({ hostname: 'iphone' }),
    );
  });

  it('ChainsPage exposes chains DataView and gates creating a chain', async () => {
    const allow = vi.fn().mockResolvedValue(true);
    const agent = createAgent({ allow });

    render(
      <>
        <ChainsPage />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    const snapText = () => JSON.stringify(agent.snapshot());
    expect(snapText()).toContain('链式代理列表');
    expect(snapText()).toContain('新建链路');

    await runAgentAct({ steps: [{ ref: '新建链路', action: 'press' }] }, { agent });
    await waitFor(() => expect(snapText()).toContain('创建链路'));

    // Switch to smart mode to verify SmartFields DataView & Collapsible
    await runAgentAct({ steps: [{ ref: '链路模式', action: 'setValue', args: ['smart'] }] }, { agent });
    await waitFor(() => expect(snapText()).toContain('前置匹配预览'));

    await runAgentAct({ steps: [{ ref: '自定义名称', action: 'press' }] }, { agent });
    await waitFor(() => expect(snapText()).toContain('链路名称'));
  });
});
