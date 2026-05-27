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

const ENTRY_YAML = 'proxies:\n  - { name: HK-01, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n';

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

  it('falls back to a stale cache entry when fetch fails', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000, // older than ttl_ms (1s)
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    const result = await resolveSubscriptionContent(makeSub());
    expect(result.stale).toBe(true);
    expect(result.staleReason).toContain('ECONNREFUSED');
    expect(result.yaml).toContain('HK-01');
  });

  it('throws when fetch fails AND no cache is present', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    await expect(resolveSubscriptionContent(makeSub())).rejects.toThrow();
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
