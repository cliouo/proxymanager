/**
 * 设备渲染与它的缓存层。
 *
 * 最重要的两条：
 *   - 设备条目的有效性判据与共享层**完全同构**（epoch/version/providerUrlBase/新鲜度），
 *     所以设备写 INCR config:version 之后无需任何显式失效代码；
 *   - 零设备/空补丁时共享渲染的产物逐字节不变（向后兼容的锚点）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device, Profile } from '@/schemas';

const store = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  counters: new Map<string, number>(),
}));

const mocks = vi.hoisted(() => ({
  getProfileByName: vi.fn(),
  getDeviceByName: vi.fn(),
  getBase: vi.fn(),
  listRules: vi.fn(),
  listRuleSets: vi.fn(),
  listSubscriptions: vi.fn(),
  listProxyGroups: vi.fn(),
  listProxyGroupTemplates: vi.fn(),
  listCollections: vi.fn(),
  resolveConfig: vi.fn(),
}));

const fakeRedis = {
  get: async (key: string) => store.kv.get(key) ?? store.counters.get(key) ?? null,
  mget: async (...keys: string[]) =>
    keys.map((k) => store.kv.get(k) ?? store.counters.get(k) ?? null),
  set: async (key: string, value: unknown) => {
    store.kv.set(key, value);
  },
  del: async (key: string) => {
    store.kv.delete(key);
  },
  incr: async (key: string) => {
    const next = (store.counters.get(key) ?? 0) + 1;
    store.counters.set(key, next);
    return next;
  },
  eval: async () => [1, ''],
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfileByName: mocks.getProfileByName }));
vi.mock('@/lib/repos/devicesRepo', () => ({ getDeviceByName: mocks.getDeviceByName }));
vi.mock('@/lib/repos/baseRepo', () => ({ getBase: mocks.getBase }));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: mocks.listRuleSets }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({ listSubscriptions: mocks.listSubscriptions }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({ listProxyGroups: mocks.listProxyGroups }));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({
  listProxyGroupTemplates: mocks.listProxyGroupTemplates,
}));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: mocks.listCollections }));
vi.mock('@/lib/engine/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/engine/resolve')>()),
  resolveConfig: mocks.resolveConfig,
}));

import { renderDeviceConfig, renderProfileConfig } from '@/lib/engine/renderCache';
import { REDIS_KEYS } from '@/lib/redis/keys';

const PROFILE = {
  id: 'p-1',
  name: 'home',
  source: { type: 'none' },
  kind: 'normal',
  updated_at: 1,
} as Profile;

const SHARED = `mixed-port: 7890
mode: rule
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
`;

function device(over: Partial<Device> = {}): Device {
  return {
    id: 'd-1',
    name: 'macbook',
    base_patch: { 'mixed-port': 7891 },
    created_at: 1,
    updated_at: 1,
    ...over,
  } as Device;
}

function resolved(content: string) {
  return {
    content,
    buildId: 'shared-build',
    anchorsApplied: [],
    unmatchedAnchors: [],
    ruleProvidersApplied: [],
    subscriptions: [],
    collisions: [],
    nodeNames: [],
    nodesBySub: {},
    warnings: [],
    inlinedProxyCount: 0,
    proxyGroupCount: 0,
  };
}

describe('renderDeviceConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.kv.clear();
    store.counters.clear();
    store.counters.set(REDIS_KEYS.configVersion, 3);
    mocks.getProfileByName.mockResolvedValue(PROFILE);
    mocks.getDeviceByName.mockResolvedValue(device());
    mocks.getBase.mockResolvedValue({
      content: SHARED,
      etag: 'base-etag',
      anchors: [],
      policies: [],
      updated_at: 11,
    });
    mocks.listRules.mockResolvedValue([]);
    mocks.listRuleSets.mockResolvedValue([]);
    mocks.listSubscriptions.mockResolvedValue([]);
    mocks.listProxyGroups.mockResolvedValue([]);
    mocks.listProxyGroupTemplates.mockResolvedValue([]);
    mocks.listCollections.mockResolvedValue([]);
    mocks.resolveConfig.mockResolvedValue(resolved(SHARED));
  });

  it('applies the device patch on top of the shared render', async () => {
    const out = await renderDeviceConfig('home', 'macbook');
    expect(out.resolved.content).toContain('mixed-port: 7891');
    expect(out.resolved.content).toContain('mode: rule');
    expect(out.cache).toBe('miss');
  });

  it('gives the device its own content-addressed buildId (no cross-device 304)', async () => {
    const a = await renderDeviceConfig('home', 'macbook');
    mocks.getDeviceByName.mockResolvedValue(
      device({ id: 'd-2', name: 'iphone', base_patch: { 'mixed-port': 7892 } }),
    );
    const b = await renderDeviceConfig('home', 'iphone');
    expect(a.resolved.buildId).not.toBe(b.resolved.buildId);
    expect(a.resolved.buildId).not.toBe('shared-build');
  });

  it('writes a cache entry keyed by device id and hits it on the second call', async () => {
    await renderDeviceConfig('home', 'macbook');
    expect(store.kv.has(REDIS_KEYS.deviceRenderCache('home', 'd-1'))).toBe(true);

    mocks.resolveConfig.mockClear();
    const second = await renderDeviceConfig('home', 'macbook');
    expect(second.cache).toBe('hit');
    // 命中时连共享渲染都不该跑。
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(second.sharedCache).toBeNull();
  });

  it('misses after config:version moves (设备写/共享写都会 INCR)', async () => {
    await renderDeviceConfig('home', 'macbook');
    store.counters.set(REDIS_KEYS.configVersion, 4);

    mocks.resolveConfig.mockClear();
    const after = await renderDeviceConfig('home', 'macbook');
    expect(after.cache).toBe('miss');
    expect(mocks.resolveConfig).toHaveBeenCalled();
  });

  it('misses when providerUrlBase differs (URL 被烘进产物)', async () => {
    await renderDeviceConfig('home', 'macbook', { providerUrlBase: 'https://a/x' });
    const other = await renderDeviceConfig('home', 'macbook', { providerUrlBase: 'https://b/x' });
    expect(other.cache).toBe('miss');
  });

  it('noCache bypasses the device cache read and forwards the flag to the shared render', async () => {
    await renderDeviceConfig('home', 'macbook');
    mocks.resolveConfig.mockClear();

    const bypass = await renderDeviceConfig('home', 'macbook', { noCache: true });
    expect(bypass.cache).toBe('bypass');
    expect(mocks.resolveConfig).toHaveBeenCalled();
    const opts = mocks.resolveConfig.mock.calls[0]?.[5] as { noCache?: boolean };
    expect(opts.noCache).toBe(true);
  });

  it('404s an unknown device', async () => {
    mocks.getDeviceByName.mockResolvedValue(null);
    await expect(renderDeviceConfig('home', 'ghost')).rejects.toMatchObject({
      problem: { status: 404 },
    });
  });

  it('404s an unknown profile', async () => {
    mocks.getProfileByName.mockResolvedValue(null);
    await expect(renderDeviceConfig('ghost', 'macbook')).rejects.toMatchObject({
      problem: { status: 404 },
    });
  });

  it('surfaces an invalid patch as a validation error rather than serving a broken config', async () => {
    mocks.getDeviceByName.mockResolvedValue(device({ base_patch: { proxies: [] } }));
    await expect(renderDeviceConfig('home', 'macbook')).rejects.toThrow(/proxies/);
  });

  it('渲染期间版本号变了会重读整份设备快照，再缓存新一代产物', async () => {
    // 渲染进行到一半时有并发写:共享渲染返回后版本号已经不是最初读到的那个。
    mocks.resolveConfig.mockImplementation(async () => {
      store.counters.set(REDIS_KEYS.configVersion, 4);
      return resolved(SHARED);
    });

    const out = await renderDeviceConfig('home', 'macbook');

    expect(out.resolved.content).toContain('mixed-port: 7891');
    expect(mocks.resolveConfig).toHaveBeenCalledTimes(2);
    expect(store.kv.has(REDIS_KEYS.deviceRenderCache('home', 'd-1'))).toBe(true);
  });

  it('缓存命中前若版本变化，会拒绝旧条目并用新设备记录重试', async () => {
    await renderDeviceConfig('home', 'macbook');
    mocks.resolveConfig.mockClear();
    mocks.getDeviceByName.mockResolvedValue(
      device({ base_patch: { 'mixed-port': 7999 }, updated_at: 2 }),
    );

    let versionReads = 0;
    const originalGet = fakeRedis.get;
    fakeRedis.get = async (key: string) => {
      if (key === REDIS_KEYS.configVersion) {
        versionReads += 1;
        if (versionReads === 2) {
          store.counters.set(REDIS_KEYS.configVersion, 4);
        }
      }
      return originalGet(key);
    };
    try {
      const out = await renderDeviceConfig('home', 'macbook');
      expect(out.cache).toBe('miss');
      expect(out.resolved.content).toContain('mixed-port: 7999');
      expect(mocks.resolveConfig).toHaveBeenCalled();
    } finally {
      fakeRedis.get = originalGet;
    }
  });

  it('读版本号在读设备记录之前(否则「新版本+旧补丁」会被永久缓存)', async () => {
    const order: string[] = [];
    const origGet = fakeRedis.get;
    fakeRedis.get = async (key: string) => {
      order.push(key === REDIS_KEYS.configVersion ? 'version' : 'other');
      return origGet(key);
    };
    mocks.getDeviceByName.mockImplementation(async () => {
      order.push('device');
      return device();
    });
    try {
      await renderDeviceConfig('home', 'macbook');
    } finally {
      fakeRedis.get = origGet;
    }
    expect(order.indexOf('version')).toBeLessThan(order.indexOf('device'));
  });

  it('零设备铁律:一份空补丁的设备产物与共享渲染逐字节相同', async () => {
    mocks.getDeviceByName.mockResolvedValue(device({ base_patch: {} }));
    const shared = await renderProfileConfig('home');
    const dev = await renderDeviceConfig('home', 'macbook');
    expect(dev.resolved.content).toBe(shared.resolved.content);
  });
});
