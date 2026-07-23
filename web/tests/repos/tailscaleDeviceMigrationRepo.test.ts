import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ eval: vi.fn() }));
vi.mock('@/lib/redis/client', () => ({ getRedis: () => mocks }));

import { commitTailscaleDeviceMigration } from '@/lib/repos/tailscaleDeviceMigrationRepo';
import { REDIS_KEYS } from '@/lib/redis/keys';

describe('commitTailscaleDeviceMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eval.mockResolvedValue([1, '8']);
  });

  it('sends base, device, rules, group, cache invalidation and backup through one Lua call', async () => {
    const result = await commitTailscaleDeviceMigration('p-1', {
      expectedVersion: 7,
      baseContent: 'proxies: []\n',
      baseMeta: { etag: 'etag', anchors: [], policies: [], updated_at: 2 },
      device: {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'server',
        base_patch: {},
        features: {},
        created_at: 1,
        updated_at: 2,
      },
      ruleDeletes: ['r-1'],
      proxyGroupDeletes: ['g-1'],
      backupKey: 'backup:migrate-tailscale-device:p-1:1',
      backupValue: { safe: true },
    });

    expect(result).toEqual({ ok: true, currentVersion: 8 });
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = mocks.eval.mock.calls[0];
    expect(keys).toEqual([
      REDIS_KEYS.configVersion,
      REDIS_KEYS.base.content('p-1'),
      REDIS_KEYS.base.meta('p-1'),
      REDIS_KEYS.devices('p-1'),
      REDIS_KEYS.rules('p-1'),
      REDIS_KEYS.proxyGroups('p-1'),
      REDIS_KEYS.resolvedSnapshot,
      'backup:migrate-tailscale-device:p-1:1',
    ]);
    expect(args).toContain('r-1');
    expect(args).toContain('g-1');
    expect(script).toContain('actual = actual.ok');
    expect(script.indexOf("redis.call('TYPE', key)")).toBeLessThan(
      script.indexOf("redis.call('SET', KEYS[8]"),
    );
    expect(script.indexOf("redis.call('TYPE', KEYS[8])")).toBeLessThan(
      script.indexOf("redis.call('SET', KEYS[8]"),
    );
  });

  it('reports the fail-closed storage guard without claiming a commit', async () => {
    mocks.eval.mockResolvedValue([-2, 'storage-type']);

    const result = await commitTailscaleDeviceMigration('p-1', {
      expectedVersion: 7,
      baseContent: 'proxies: []\n',
      baseMeta: { etag: 'etag', anchors: [], policies: [], updated_at: 2 },
      device: {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'server',
        base_patch: {},
        features: {},
        created_at: 1,
        updated_at: 2,
      },
      ruleDeletes: ['r-1'],
      proxyGroupDeletes: ['g-1'],
      backupKey: 'backup:migrate-tailscale-device:p-1:1',
      backupValue: { safe: true },
    });

    expect(result).toEqual({ ok: false, currentVersion: null, conflict: 'storage' });
  });
});
