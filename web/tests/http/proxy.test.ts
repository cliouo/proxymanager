import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const rateLimit = vi.hoisted(() => ({
  registerAuthFailure: vi.fn(async () => false),
  clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/rateLimit', () => rateLimit);

import { proxy } from '@/proxy';

const ORIGINAL_ADMIN_KEY = process.env.ADMIN_KEY;
const ADMIN_KEY = 'test-admin-key';
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers':
    'Authorization, Content-Type, If-Match, X-Fetch-Identity-Revision, X-Source',
  'access-control-expose-headers': 'ETag, X-Build-Id, Location',
  'access-control-max-age': '86400',
} as const;

function request(
  pathname: string,
  method: string,
  options: { origin?: string; authorization?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (options.origin) headers.set('Origin', options.origin);
  if (options.authorization) headers.set('Authorization', options.authorization);
  return new NextRequest(`https://pm.test${pathname}`, { method, headers });
}

function expectExactCors(response: Response): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  expect((response.headers.get('vary') ?? '').toLowerCase()).not.toContain('origin');
}

describe('proxy CORS and authentication partition', () => {
  beforeEach(() => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    rateLimit.registerAuthFailure.mockReset().mockResolvedValue(false);
    rateLimit.clientIp.mockClear();
  });

  afterAll(() => {
    if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = ORIGINAL_ADMIN_KEY;
  });

  it.each([
    ['external origin', 'https://outside.example'],
    ['same origin', 'https://pm.test'],
    ['missing Origin', undefined],
  ])(
    'answers %s preflight before auth with a bodyless exact wildcard matrix',
    async (_case, origin) => {
      const response = await proxy(
        request('/api/v1/subscriptions/example/manual-refresh', 'OPTIONS', { origin }),
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expectExactCors(response);
      expect(rateLimit.registerAuthFailure).not.toHaveBeenCalled();
    },
  );

  it('does not let a successful preflight bypass auth on the real request', async () => {
    const pathname = '/api/v1/subscriptions/example/manual-refresh';
    expect(
      (await proxy(request(pathname, 'OPTIONS', { origin: 'https://outside.example' }))).status,
    ).toBe(204);

    const response = await proxy(request(pathname, 'POST', { origin: 'https://outside.example' }));
    expect(response.status).toBe(401);
    expectExactCors(response);
  });

  it('allows a public GET without authentication and still emits the exact matrix', async () => {
    const response = await proxy(
      request('/api/v1/health', 'GET', { origin: 'https://outside.example' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expectExactCors(response);
    expect(rateLimit.registerAuthFailure).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'allows an authenticated external-origin %s and emits the exact matrix',
    async (method) => {
      const response = await proxy(
        request('/api/v1/subscriptions/example', method, {
          origin: 'https://outside.example',
          authorization: `Bearer ${ADMIN_KEY}`,
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expectExactCors(response);
    },
  );

  it('returns 401 with the exact matrix and no supplied token disclosure', async () => {
    const supplied = 'sentinel-invalid-token';
    const response = await proxy(
      request('/api/v1/subscriptions/example', 'GET', {
        origin: 'https://outside.example',
        authorization: `Bearer ${supplied}`,
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(401);
    expectExactCors(response);
    expect(body).not.toContain(supplied);
    expect(body).not.toContain(ADMIN_KEY);
  });

  it('returns 429 with the exact matrix', async () => {
    rateLimit.registerAuthFailure.mockResolvedValueOnce(true);
    const response = await proxy(
      request('/api/v1/subscriptions/example', 'GET', {
        origin: 'https://outside.example',
        authorization: 'Bearer invalid',
      }),
    );

    expect(response.status).toBe(429);
    expectExactCors(response);
    expect(response.headers.get('retry-after')).toBe('300');
  });

  it.each([
    '/api/v1/subscriptions/example/local-fetch-spec',
    '/api/v1/subscriptions/example/manual-refresh',
  ])('applies no-store to every middleware outcome for %s', async (pathname) => {
    const preflight = await proxy(
      request(pathname, 'OPTIONS', { origin: 'https://outside.example' }),
    );
    const unauthorized = await proxy(
      request(pathname, 'GET', { origin: 'https://outside.example' }),
    );
    const passThrough = await proxy(
      request(pathname, 'GET', {
        origin: 'https://outside.example',
        authorization: `Bearer ${ADMIN_KEY}`,
      }),
    );

    for (const response of [preflight, unauthorized, passThrough]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expectExactCors(response);
    }
  });

  it('returns a CORS-readable 500 when ADMIN_KEY is missing without disclosing a key', async () => {
    delete process.env.ADMIN_KEY;
    const response = await proxy(
      request('/api/v1/subscriptions/example', 'GET', { origin: 'https://outside.example' }),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expectExactCors(response);
    expect(body).not.toContain(ADMIN_KEY);
    expect(rateLimit.registerAuthFailure).not.toHaveBeenCalled();
  });
});
