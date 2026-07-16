import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const { redisGet } = vi.hoisted(() => ({ redisGet: vi.fn() }));
vi.mock('@/lib/redis/client', () => ({
  getRedis: () => ({ get: redisGet }),
}));

import { buildCacheKey, getFetchCache } from '@/lib/repos/fetchCacheRepo';

describe('fetch cache parser epoch', () => {
  it('does not reuse keys created before proxy normalisation became fail-closed', () => {
    const parts = {
      url: 'https://upstream.example/sub',
      userAgent: 'test-agent',
      headers: { Authorization: 'Bearer FAKE_TOKEN' },
    };
    const legacyHeaderString = JSON.stringify({ Authorization: 'Bearer FAKE_TOKEN' });
    const legacyKey = createHash('sha256')
      .update(`${parts.url}\x00${parts.userAgent}\x00${legacyHeaderString}`)
      .digest('hex')
      .slice(0, 16);

    expect(buildCacheKey(parts)).not.toBe(legacyKey);
  });

  it('accepts a complete cache envelope', async () => {
    redisGet.mockResolvedValueOnce({
      content: 'proxies: []\n',
      fetched_at: 1_700_000_000_000,
      proxy_count: 0,
      traffic: { upload: 0, download: 1, total: 2, expire: 3 },
    });

    await expect(getFetchCache('safe-key')).resolves.toEqual({
      content: 'proxies: []\n',
      fetched_at: 1_700_000_000_000,
      proxy_count: 0,
      traffic: { upload: 0, download: 1, total: 2, expire: 3 },
    });
  });

  it.each([
    ['non-object', 'FAKE_SECRET_DO_NOT_LOG'],
    ['missing content', { fetched_at: 1, proxy_count: 1 }],
    ['bad timestamp', { content: 'proxies: []', fetched_at: '1', proxy_count: 0 }],
    [
      'far-future timestamp',
      {
        content: 'proxies: []',
        fetched_at: Date.now() + 24 * 60 * 60 * 1000,
        proxy_count: 0,
      },
    ],
    ['bad count', { content: 'proxies: []', fetched_at: 1, proxy_count: -1 }],
    [
      'bad traffic',
      {
        content: 'proxies: []',
        fetched_at: 1,
        proxy_count: 0,
        traffic: { upload: -1, download: 0, total: 0, expire: 0 },
      },
    ],
  ])('treats a corrupt %s envelope as a cache miss', async (_label, value) => {
    redisGet.mockResolvedValueOnce(value);
    await expect(getFetchCache('safe-key')).resolves.toBeNull();
  });
});
