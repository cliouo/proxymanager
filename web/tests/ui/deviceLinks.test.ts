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
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response('yaml', { headers: { 'Content-Type': 'text/yaml; charset=utf-8' } }),
    );
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

it('keeps listener, TUN and mode locations in a compatibility 422', async () => {
  const issues = [
    {
      status: 'unverified',
      listener: 'mixed-in',
      table: 'office',
      ruleNumber: 1,
      ruleType: 'PROCESS-NAME',
      target: '出口',
      reason: '进程规则待核验',
    },
    {
      status: 'unverified',
      field: 'route-exclude-address-set',
      setName: 'remote-ip',
      reference: 'remote-ip',
      reason: '远程集合待核验',
    },
    {
      status: 'unverified',
      mode: 'global',
      reference: 'GLOBAL',
      member: 'B',
      option: 'type=socks5',
      reason: '全局选路待核验',
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ errors: issues }, { status: 422 })),
  );
  expect(await recheckShadowrocket(url, signal)).toEqual(issues);
});

it('reports a login page in place of a successful YAML download', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('login', { headers: { 'Content-Type': 'text/html' } })),
  );
  await expect(recheckShadowrocket(url, signal)).rejects.toThrow('YAML');
});
