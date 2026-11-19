import { afterEach, expect, it, vi } from 'vitest';
import { deviceLink } from '@/ui/features/devices/model';
import { recheckShadowrocket } from '@/ui/features/devices/subscriptionCheck';

const base = 'https://pm.example/api/sub/test/home';
const url = base + '/phone?client=shadowrocket';
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

it('builds all three device links from the saved resource', () => {
  expect(deviceLink(base, 'phone')).toBe(base + '/phone');
  expect(deviceLink(base, 'phone', 'shadowrocket')).toBe(url);
  expect(deviceLink(base, 'phone', 'base64')).toBe(base + '/phone?format=base64');
});

it('reads the token-scoped link without cookies, administrator headers or cached responses', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('yaml'));
  vi.stubGlobal('fetch', fetch);
  expect(await recheckShadowrocket(url, signal)).toEqual([]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, {
    credentials: 'omit',
    cache: 'no-store',
    signal,
  });
});

it.each([[], [{ path: 'base_patch' }], [{ status: 'unverified', ruleNumber: 1 }]])(
  'keeps a renderer 422 out of compatibility results',
  async (...errors) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ detail: '渲染失败', errors }, { status: 422 })),
    );
    await expect(recheckShadowrocket(url, signal)).rejects.toThrow('渲染失败');
  },
);
