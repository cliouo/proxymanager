/**
 * 设备层的校验闸口是 preflightProfileConfig —— 且**只有**它。
 *
 * 这组测试盯的是设计里最重要的那条推论：改共享层会自动校验全部设备，任何入口都
 * 绕不过去；改设备走同一函数。若有人日后新开一条不经 preflight 的写路径，
 * 「共享层保存破坏设备」这条会立刻变绿失效 —— 它就是那道护栏的报警器。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device, Profile } from '@/schemas';

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  resolveSubscriptionProxies: vi.fn(),
  getBase: vi.fn(),
  getConfigVersion: vi.fn(),
  getProfile: vi.fn(),
  listCollections: vi.fn(),
  listProxyGroups: vi.fn(),
  listProxyGroupTemplates: vi.fn(),
  listRules: vi.fn(),
  listRuleSets: vi.fn(),
  listSubscriptions: vi.fn(),
  listDevices: vi.fn(),
}));

// 只替换 resolveConfig：这组测试要精确控制「候选渲染出来是什么」，才能断言设备
// 补丁是对着**候选产物**校验的。`validateFinalRenderedConfig` 必须保持真身 ——
// 它正是被测的那道校验，换成替身这组测试就什么都证明不了。
vi.mock('@/lib/engine/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/engine/resolve')>()),
  resolveConfig: mocks.resolveConfig,
}));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxies: mocks.resolveSubscriptionProxies,
}));
vi.mock('@/lib/repos/baseRepo', () => ({ getBase: mocks.getBase }));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: mocks.getConfigVersion }));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: mocks.getProfile }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: mocks.listCollections }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({ listProxyGroups: mocks.listProxyGroups }));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({
  listProxyGroupTemplates: mocks.listProxyGroupTemplates,
}));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: mocks.listRuleSets }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({ listSubscriptions: mocks.listSubscriptions }));
vi.mock('@/lib/repos/devicesRepo', () => ({ listDevices: mocks.listDevices }));

import { ConfigValidationError } from '@/lib/config/errors';
import { preflightProfileConfig } from '@/lib/services/configPreflight';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE = {
  id: PROFILE_ID,
  name: 'default',
  source: { type: 'none' },
  kind: 'normal',
  updated_at: 1,
} as Profile;

const RENDERED = `mixed-port: 7890
mode: rule
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
`;

function device(over: Partial<Device>): Device {
  return {
    id: crypto.randomUUID(),
    name: 'macbook',
    base_patch: {},
    features: {},
    created_at: 1,
    updated_at: 1,
    ...over,
  } as Device;
}

async function preflight(devices?: Device[]) {
  return preflightProfileConfig(PROFILE_ID, () => (devices ? { devices } : {}));
}

describe('preflightProfileConfig — 设备闸口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigVersion.mockResolvedValue(7);
    mocks.getProfile.mockResolvedValue(PROFILE);
    mocks.getBase.mockResolvedValue({
      content: RENDERED,
      etag: 'e',
      anchors: [],
      policies: [],
      updated_at: 1,
    });
    mocks.listRules.mockResolvedValue([]);
    mocks.listSubscriptions.mockResolvedValue([]);
    mocks.listProxyGroups.mockResolvedValue([]);
    mocks.listProxyGroupTemplates.mockResolvedValue([]);
    mocks.listRuleSets.mockResolvedValue([]);
    mocks.listCollections.mockResolvedValue([]);
    mocks.listDevices.mockResolvedValue([]);
    mocks.resolveConfig.mockResolvedValue({ content: RENDERED });
  });

  it('零设备时不做任何设备工作(回归锚点)', async () => {
    const result = await preflight();
    expect(result.configVersion).toBe(7);
    expect(result.candidate.devices).toEqual([]);
  });

  it('loads the profile devices inside the version bracket', async () => {
    const d = device({ base_patch: { 'mixed-port': 7891 } });
    mocks.listDevices.mockResolvedValue([d]);
    const result = await preflight();
    expect(mocks.listDevices).toHaveBeenCalledWith(PROFILE_ID);
    expect(result.candidate.devices).toEqual([d]);
  });

  it('accepts a stored device whose patch still applies cleanly', async () => {
    mocks.listDevices.mockResolvedValue([device({ base_patch: { 'external-ui': 'ui' } })]);
    await expect(preflight()).resolves.toBeDefined();
  });

  it('BLOCKS a shared-layer save that would break a stored device, naming the device', async () => {
    mocks.listDevices.mockResolvedValue([
      device({ name: 'home-server', base_patch: { 'proxy-providers': 'not-a-map' } }),
    ]);
    const error = await preflight().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigValidationError);
    const issue = (error as ConfigValidationError).issue;
    expect(issue.section).toBe('devices');
    expect(issue.message).toContain('home-server');
    expect(issue.path).toContain('devices[home-server]');
  });

  it('names every affected device, not just the first', async () => {
    mocks.listDevices.mockResolvedValue([
      device({ name: 'aaa', base_patch: { 'proxy-providers': 'bad' } }),
      device({ name: 'bbb', base_patch: { 'proxy-providers': 'bad' } }),
    ]);
    const error = (await preflight().catch((e: unknown) => e)) as ConfigValidationError;
    expect(error.message).toContain('aaa');
    expect(error.message).toContain('bbb');
  });

  it('validates the CANDIDATE devices when a device mutation supplies them', async () => {
    // 库里存的是干净的，候选里是要新写入的那台 —— 校验必须针对候选。
    mocks.listDevices.mockResolvedValue([]);
    const error = await preflight([device({ name: 'new-one', base_patch: { proxies: [] } })]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).issue.code).toBe('device_patch_managed_key');
  });

  it('lets a device mutation REMOVE a broken device (candidate wins over storage)', async () => {
    mocks.listDevices.mockResolvedValue([
      device({ name: 'broken', base_patch: { 'proxy-providers': 'bad' } }),
    ]);
    // 删掉那台坏设备的候选必须能过 —— 否则用户被自己的坏补丁锁死，无法自救。
    await expect(preflight([])).resolves.toBeDefined();
  });

  it('validates against the CANDIDATE render, not the stored base', async () => {
    // 候选渲染产物里有 dns 段;设备补丁往里深合并一个字段 —— 只有对着**候选**
    // 校验才判得对(库里那份 base 根本没有 dns)。
    mocks.resolveConfig.mockResolvedValue({
      content: `proxies: []\nproxy-groups: []\nrules: []\ndns:\n  enable: true\n`,
    });
    mocks.listDevices.mockResolvedValue([
      device({ base_patch: { dns: { listen: '0.0.0.0:53' } } }),
    ]);
    await expect(preflight()).resolves.toBeDefined();
  });

  it('validates a typed device Tailscale feature against the candidate render', async () => {
    mocks.listDevices.mockResolvedValue([
      device({
        name: 'server',
        features: {
          tailscale: {
            hostname: 'server-ts',
            acceptRoutes: true,
            udp: true,
            ephemeral: false,
            exitNodeAllowLanAccess: false,
            extraCidrs: [],
          },
        },
      }),
    ]);
    await expect(preflight()).resolves.toBeDefined();
  });

  it('blocks a device feature while the shared candidate still contains legacy Tailscale', async () => {
    mocks.resolveConfig.mockResolvedValue({
      content: RENDERED.replace(
        'proxies: []',
        'proxies:\n  - {name: old-ts, type: tailscale, hostname: old}',
      ),
    });
    mocks.listDevices.mockResolvedValue([
      device({
        name: 'server',
        features: {
          tailscale: {
            hostname: 'server-ts',
            acceptRoutes: true,
            udp: true,
            ephemeral: false,
            exitNodeAllowLanAccess: false,
            extraCidrs: [],
          },
        },
      }),
    ]);

    const error = (await preflight().catch((cause: unknown) => cause)) as ConfigValidationError;
    expect(error.issue.code).toBe('device_tailscale_legacy_conflict');
    expect(error.message).toContain('server');
  });
});
