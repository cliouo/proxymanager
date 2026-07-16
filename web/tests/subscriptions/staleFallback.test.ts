import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '@/schemas';

vi.mock('@/lib/repos/fetchCacheRepo', () => ({
  buildCacheKey: vi.fn(() => 'fixed-cache-key'),
  getFetchCache: vi.fn(),
  setFetchCache: vi.fn(async () => undefined),
}));

import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import { getFetchCache, setFetchCache } from '@/lib/repos/fetchCacheRepo';

const getCacheMock = getFetchCache as unknown as ReturnType<typeof vi.fn>;
const setCacheMock = setFetchCache as unknown as ReturnType<typeof vi.fn>;

function makeSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 'id',
    name: 'air',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 1000,
    tags: [],
    operators: [],
    ...over,
  } as Subscription;
}

const ENTRY_YAML =
  'proxies:\n  - { name: HK-01, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n';

describe('resolveSubscriptionContent — stale-on-error', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    getCacheMock.mockReset();
    setCacheMock.mockClear();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('serves fresh cache without hitting fetch', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now(), // fresh
    });

    const result = await resolveSubscriptionContent(makeSub());
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.stale).toBeUndefined();
    expect(result.yaml).toContain('HK-01');
  });

  it('treats a corrupt fresh payload as a miss, refetches, and replaces it', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: 'proxies:\n  - name: CORRUPT_CACHE_SENTINEL\n',
      proxy_count: 1,
      fetched_at: Date.now(),
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        'proxies:\n  - { name: FRESH, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
        { status: 200 },
      ),
    );

    const result = await resolveSubscriptionContent(makeSub());

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.stale).toBeUndefined();
    expect(result.yaml).toContain('FRESH');
    expect(result.yaml).not.toContain('CORRUPT_CACHE_SENTINEL');
    expect(setCacheMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cache entry when fetch fails', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000, // older than ttl_ms (1s)
    });
    const sentinel = 'FAKE_UPSTREAM_TOKEN_DO_NOT_USE';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(sentinel));

    const result = await resolveSubscriptionContent(makeSub());
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe('Upstream fetch failed');
    expect(result.staleReason).not.toContain(sentinel);
    expect(result.yaml).toContain('HK-01');
  });

  it('does not use a corrupt stale payload when the refetch also fails', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: 'proxies:\n  - name: CORRUPT_CACHE_SENTINEL\n',
      proxy_count: 1,
      fetched_at: Date.now() - 60_000,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    await expect(resolveSubscriptionContent(makeSub())).rejects.toThrow('Upstream fetch failed');
  });

  it('throws when fetch fails AND no cache is present', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    await expect(resolveSubscriptionContent(makeSub())).rejects.toThrow();
  });

  it('rejects a cross-origin redirect before custom subscription headers can be forwarded', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    const token = 'FAKE_CUSTOM_HEADER_SECRET_DO_NOT_USE';
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://collector.invalid/stolen' },
      }),
    );

    await expect(
      resolveSubscriptionContent(makeSub({ custom_headers: { 'X-Subscription-Token': token } }), {
        noCache: true,
      }),
    ).rejects.toThrow('Cross-origin upstream redirect is not allowed');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(firstUrl.origin).toBe('https://upstream.example');
    expect((firstInit.headers as Record<string, string>)['X-Subscription-Token']).toBe(token);
  });

  it('follows bounded same-origin redirects while preserving the configured headers', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    const token = 'FAKE_SAME_ORIGIN_TOKEN_ONLY';
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: '/final-provider' } }),
      )
      .mockResolvedValueOnce(new Response(ENTRY_YAML, { status: 200 }));

    const result = await resolveSubscriptionContent(
      makeSub({ custom_headers: { Authorization: `Bearer ${token}` } }),
      { noCache: true },
    );

    expect(result.yaml).toContain('HK-01');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondUrl, secondInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(secondUrl.toString()).toBe('https://upstream.example/final-provider');
    expect((secondInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it('with noCache=true, ignores cache and surfaces fetch errors instead of going stale', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now(),
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    await expect(resolveSubscriptionContent(makeSub(), { noCache: true })).rejects.toThrow();
    expect(getCacheMock).not.toHaveBeenCalled();
  });

  it('refetches and persists when cache is stale (no error path)', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000, // stale
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        'proxies:\n  - { name: FRESH, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
        { status: 200 },
      ),
    );

    const result = await resolveSubscriptionContent(makeSub());
    expect(result.stale).toBeUndefined();
    expect(result.yaml).toContain('FRESH');
    expect(setCacheMock).toHaveBeenCalledTimes(1);
  });
});
