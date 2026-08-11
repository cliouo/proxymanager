import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '@/schemas';

vi.mock('@/lib/repos/fetchCacheRepo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/repos/fetchCacheRepo')>()),
  buildCacheKey: vi.fn(() => 'fixed-cache-key'),
  getFetchCache: vi.fn(),
  setFetchCache: vi.fn(async () => undefined),
}));

const healthMock = vi.hoisted(() => ({
  recordSubscriptionFetchHealth: vi.fn<(sub: Subscription, health: unknown) => Promise<void>>(
    async () => undefined,
  ),
}));
vi.mock('@/lib/repos/subscriptionFetchHealthRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/subscriptionFetchHealthRepo')>();
  return {
    ...actual,
    recordSubscriptionFetchHealth: healthMock.recordSubscriptionFetchHealth,
  };
});

import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import { buildCacheKey, getFetchCache, setFetchCache } from '@/lib/repos/fetchCacheRepo';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  RemoteFetchAttemptError,
  SubscriptionResolutionValidationError,
  isEligibleFetchFailure,
} from '@/lib/services/subscriptionResolutionErrors';

const buildCacheMock = buildCacheKey as unknown as ReturnType<typeof vi.fn>;
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

function healthCalls(): Array<{ sub: Subscription; health: Record<string, unknown> }> {
  return healthMock.recordSubscriptionFetchHealth.mock.calls.map(([sub, health]) => ({
    sub: sub as Subscription,
    health: health as Record<string, unknown>,
  }));
}

describe('resolveSubscriptionContent — fetch failure policy (v1)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    getCacheMock.mockReset();
    setCacheMock.mockClear();
    buildCacheMock.mockClear();
    healthMock.recordSubscriptionFetchHealth.mockClear();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it.each(['User-Agent', 'user-agent', 'uSeR-aGeNt'])(
    'sends the dedicated UA and retained headers while excluding custom %s from cache identity',
    async (headerName) => {
      let observedUserAgent: string | undefined;
      let observedTestHeader: string | undefined;
      const server = createServer((request, response) => {
        const rawUserAgent = request.headers['user-agent'];
        const rawTestHeader = request.headers['x-test'];
        observedUserAgent = Array.isArray(rawUserAgent) ? rawUserAgent[0] : rawUserAgent;
        observedTestHeader = Array.isArray(rawTestHeader) ? rawTestHeader[0] : rawTestHeader;
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(ENTRY_YAML);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('loopback server unavailable');

      try {
        globalThis.fetch = realFetch;
        getCacheMock.mockResolvedValueOnce(null);
        await resolveSubscriptionContent(
          makeSub({
            url: `http://127.0.0.1:${address.port}/subscription`,
            ua_override: 'dedicated-test-ua',
            custom_headers: {
              [headerName]: 'sentinel-ignored-ua',
              'X-Test': 'retained',
            },
          }),
        );

        expect(observedUserAgent).toBe('dedicated-test-ua');
        expect(observedTestHeader).toBe('retained');
        expect(buildCacheMock).toHaveBeenCalledWith({
          url: `http://127.0.0.1:${address.port}/subscription`,
          userAgent: 'dedicated-test-ua',
          headers: { 'X-Test': 'retained' },
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  describe('fresh-attempt classification — real bytes for all six categories', () => {
    it('network: a fetch rejection classifies as network (503)', async () => {
      getCacheMock.mockResolvedValueOnce(null);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('connect ECONNREFUSED'),
      );

      const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
      expect(error).toBeInstanceOf(RemoteFetchAttemptError);
      expect((error as RemoteFetchAttemptError).category).toBe('network');
      expect((error as RemoteFetchAttemptError).problem.status).toBe(503);
    });

    it('timeout: an AbortError from fetch classifies as timeout (503)', async () => {
      getCacheMock.mockResolvedValueOnce(null);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new DOMException('aborted', 'AbortError'),
      );

      const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
      expect(error).toBeInstanceOf(RemoteFetchAttemptError);
      expect((error as RemoteFetchAttemptError).category).toBe('timeout');
      expect((error as RemoteFetchAttemptError).problem.status).toBe(503);
      expect((error as Error).message).toBe('Upstream fetch timed out');
    });

    it('http: a non-2xx response classifies as http (503)', async () => {
      getCacheMock.mockResolvedValueOnce(null);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response('nope', { status: 502 }),
      );

      const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
      expect(error).toBeInstanceOf(RemoteFetchAttemptError);
      expect((error as RemoteFetchAttemptError).category).toBe('http');
      expect((error as RemoteFetchAttemptError).problem.status).toBe(503);
    });

    it('response-encoding: fatal UTF-8 bytes classifies as response-encoding (422)', async () => {
      getCacheMock.mockResolvedValueOnce(null);
      const bad = new Uint8Array([0x70, 0x72, 0x6f, 0xff, 0x78]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(bad, { status: 200 }),
      );

      const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
      expect(error).toBeInstanceOf(RemoteFetchAttemptError);
      expect((error as RemoteFetchAttemptError).category).toBe('response-encoding');
      expect((error as RemoteFetchAttemptError).problem.status).toBe(422);
      expect((error as Error).message).toBe('Upstream response is not valid UTF-8');
    });

    it('response-content-format: unrecognised fresh bytes classify as response-content-format (422)', async () => {
      getCacheMock.mockResolvedValueOnce(null);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response('this is not a subscription payload', { status: 200 }),
      );

      const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
      expect(error).toBeInstanceOf(RemoteFetchAttemptError);
      expect((error as RemoteFetchAttemptError).category).toBe('response-content-format');
      expect((error as RemoteFetchAttemptError).problem.status).toBe(422);
    });

    it('proxy-node: a structured invalid URI entry classifies as proxy-node (422)', async () => {
      getCacheMock.mockResolvedValueOnce(null);
      const badList =
        'trojan://safe@example.invalid:443#valid\n' +
        'juicity-secretmarker://credential@example.invalid:443#bad';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(badList, { status: 200 }),
      );

      const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
      expect(error).toBeInstanceOf(RemoteFetchAttemptError);
      expect((error as RemoteFetchAttemptError).category).toBe('proxy-node');
      expect((error as RemoteFetchAttemptError).problem.status).toBe(422);
      expect((error as Error).message).toBe('Upstream response contains invalid proxy nodes');
      expect((error as Error).message).not.toContain('juicity-secretmarker');
    });

    it('closed-enum eligibility: only the six fixed categories qualify', async () => {
      for (const category of [
        'network',
        'timeout',
        'http',
        'response-encoding',
        'response-content-format',
        'proxy-node',
      ] as const) {
        expect(isEligibleFetchFailure(new RemoteFetchAttemptError(category))).toBe(true);
      }
      // A forged instanceof with an out-of-enum category never qualifies.
      // The category field is `readonly` in the constructor type, so the
      // forgery is applied runtime-only (never a typed assignment).
      const forged = Object.create(RemoteFetchAttemptError.prototype) as RemoteFetchAttemptError;
      Object.defineProperty(forged, 'category', { value: 'bogus' });
      expect(isEligibleFetchFailure(forged)).toBe(false);
      // Generic ProblemDetails and deterministic validation errors never qualify.
      expect(
        isEligibleFetchFailure(
          new ProblemDetailsError({
            type: 'https://proxymanager.dev/errors/generic',
            title: 'generic',
            status: 500,
          }),
        ),
      ).toBe(false);
    });

    it('negative: operator-stage failures stay ineligible even with a cache present', async () => {
      getCacheMock.mockResolvedValueOnce(null);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(ENTRY_YAML, { status: 200 }),
      );
      const invalidLegacyOperator = {
        id: 'legacy-invalid',
        kind: 'filter-useless',
        extra: ['('],
      } as Subscription['operators'][number];

      const error = await resolveSubscriptionContent(
        makeSub({ operators: [invalidLegacyOperator] }),
        { writeCache: false, recordHealth: false },
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(SubscriptionResolutionValidationError);
      expect(isEligibleFetchFailure(error)).toBe(false);
    });
  });

  it('serves fresh cache without hitting fetch and without recording health', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now(), // fresh
    });

    const result = await resolveSubscriptionContent(makeSub());
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.stale).toBeUndefined();
    expect(result.yaml).toContain('HK-01');
    expect(healthMock.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
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

  it('a fresh attempt success serves latest and records fresh health (default recordHealth)', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000,
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
    const recorded = healthCalls();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].health.state).toBe('fresh');
    expect(recorded[0].health.proxy_count).toBe(1);
    expect(recorded[0].health.definition_fingerprint).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('eligible failure + tolerant + valid retained cache → stale-serve with fixed reason + stale-served health', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000, // older than ttl_ms (1s)
    });
    const sentinel = 'FAKE_UPSTREAM_TOKEN_DO_NOT_USE';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(sentinel));

    const result = await resolveSubscriptionContent(makeSub());
    expect(result.stale).toBe(true);
    // Fixed category sentence only — never the raw upstream diagnostic.
    expect(result.staleReason).toBe('Upstream fetch failed');
    expect(result.staleReason).not.toContain(sentinel);
    expect(result.yaml).toContain('HK-01');

    const recorded = healthCalls();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].health).toMatchObject({
      state: 'stale-served',
      failure_category: 'network',
      cache_disposition: 'served',
      proxy_count: 1,
    });
  });

  it('eligible failure + tolerant + no cache → typed error + failed-no-cache health', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteFetchAttemptError);
    expect(isEligibleFetchFailure(error)).toBe(true);
    expect((error as Error).message).toBe('Upstream fetch failed');
    expect(setCacheMock).not.toHaveBeenCalled();
    const recorded = healthCalls();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].health).toMatchObject({
      state: 'failed-no-cache',
      failure_category: 'network',
      cache_disposition: 'unavailable',
    });
    expect(recorded[0].health.proxy_count).toBeUndefined();
  });

  it('eligible failure + strict (fail-closed) + valid cache → typed error, cache deliberately not served', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    const error = await resolveSubscriptionContent(
      makeSub({ fetch_failure_policy: 'fail-closed' }),
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteFetchAttemptError);
    expect((error as RemoteFetchAttemptError).category).toBe('network');
    const recorded = healthCalls();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].health).toMatchObject({
      state: 'failed-no-cache',
      cache_disposition: 'policy-blocked',
    });
  });

  it('eligible failure + strict + invalid cache → failed-no-cache invalid disposition', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: 'proxies:\n  - name: CORRUPT_CACHE_SENTINEL\n',
      proxy_count: 1,
      fetched_at: Date.now() - 60_000,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    const error = await resolveSubscriptionContent(
      makeSub({ fetch_failure_policy: 'fail-closed' }),
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteFetchAttemptError);
    const recorded = healthCalls();
    expect(recorded[0].health).toMatchObject({ cache_disposition: 'invalid' });
  });

  it('noCache=1 bypasses cache reads, stale and policy; records bypassed health', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now(),
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    const error = await resolveSubscriptionContent(
      makeSub({ fetch_failure_policy: 'fail-closed' }),
      { noCache: true },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteFetchAttemptError);
    expect(getCacheMock).not.toHaveBeenCalled();
    const recorded = healthCalls();
    expect(recorded[0].health).toMatchObject({ cache_disposition: 'bypassed' });
  });

  it('a reader.read PROMISE rejection is eligible body transport: stale fallback + stale-served health', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000, // expired, retained LKG
    });
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: {
        getReader: () => ({
          read: () => Promise.reject(new Error('stream broke')),
          cancel: () => Promise.resolve(),
        }),
      },
      configurable: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(res);

    const result = await resolveSubscriptionContent(makeSub());
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe('Upstream fetch failed');
    expect(result.yaml).toContain('HK-01');
    const recorded = healthCalls();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].health).toMatchObject({
      state: 'stale-served',
      failure_category: 'network',
      cache_disposition: 'served',
    });
  });

  it('a synchronous reader.read INVOCATION fault is a programming fault: no stale, no skip, no health', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000,
    });
    const syncFault = new Error('sync read invocation fault');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: {
        getReader: () => ({
          read: () => {
            throw syncFault;
          },
          cancel: () => Promise.resolve(),
        }),
      },
      configurable: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(res);

    // A raw Error is not a RemoteFetchAttemptError — even a generic network
    // lookalike must not confer eligibility.
    expect(isEligibleFetchFailure(new Error('network down'))).toBe(false);
    const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
    // The identical programming fault propagates — a valid LKG exists but is
    // NOT served: no stale, no skip authorization, no health receipt.
    expect(error).toBe(syncFault);
    expect(isEligibleFetchFailure(error)).toBe(false);
    expect(healthMock.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
    expect(getCacheMock).toHaveBeenCalledTimes(1);
  });

  it('a SYNCHRONOUS AbortError from the body getter is NOT timeout: identity, no stale, no health', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000,
    });
    const abort = new DOMException('body getter aborted', 'AbortError');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      get() {
        throw abort;
      },
      configurable: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(res);

    const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
    // Exact identity — a synchronous body-access AbortError is NOT the
    // timeout category (I4), so no stale fallback and no health receipt.
    expect(error).toBe(abort);
    expect(isEligibleFetchFailure(error)).toBe(false);
    expect(healthMock.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('a post-resolution CHUNK fault is a programming fault: no stale, no skip, no health', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now() - 60_000,
    });
    const chunkFault = new Error('chunk byteLength fault');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: {
        getReader: () => ({
          read: () =>
            Promise.resolve({
              done: false,
              value: {
                get byteLength() {
                  throw chunkFault;
                },
              },
            }),
          cancel: () => Promise.resolve(),
        }),
      },
      configurable: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(res);

    const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
    expect(error).toBe(chunkFault);
    expect(isEligibleFetchFailure(error)).toBe(false);
    expect(healthMock.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('classifies a post-fetch operator failure as deterministic validation (ineligible)', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(ENTRY_YAML, { status: 200 }),
    );
    const invalidLegacyOperator = {
      id: 'legacy-invalid',
      kind: 'filter-useless',
      extra: ['('],
    } as Subscription['operators'][number];

    const error = await resolveSubscriptionContent(
      makeSub({ operators: [invalidLegacyOperator] }),
      { writeCache: false, recordHealth: false },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(SubscriptionResolutionValidationError);
    expect((error as SubscriptionResolutionValidationError).stage).toBe('operators');
    expect(isEligibleFetchFailure(error)).toBe(false);
    expect(healthMock.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
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

    const error = await resolveSubscriptionContent(makeSub()).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteFetchAttemptError);
    const recorded = healthCalls();
    expect(recorded[0].health).toMatchObject({ cache_disposition: 'invalid' });
  });

  it('writeCache false + recordHealth false: fresh success persists nothing and records no health', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(ENTRY_YAML, { status: 200 }),
    );

    const result = await resolveSubscriptionContent(makeSub(), {
      writeCache: false,
      recordHealth: false,
    });

    expect(result.yaml).toContain('HK-01');
    expect(setCacheMock).not.toHaveBeenCalled();
    expect(healthMock.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('keeps the historical 10 MiB server-fetch contract independent from 4 MiB uploads', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    const overManualLimit = `${ENTRY_YAML}#${'x'.repeat(4 * 1024 * 1024)}`;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(overManualLimit, { status: 200 }),
    );

    await expect(
      resolveSubscriptionContent(makeSub(), { writeCache: false, recordHealth: false }),
    ).resolves.toMatchObject({ proxyCount: 1 });
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

    const error = await resolveSubscriptionContent(
      makeSub({ custom_headers: { 'X-Subscription-Token': token } }),
      { noCache: true },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteFetchAttemptError);
    expect((error as RemoteFetchAttemptError).category).toBe('http');
    // 503 problem shape for transport categories.
    expect((error as RemoteFetchAttemptError).problem.status).toBe(503);

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

  it('with noCache=true, ignores cache and surfaces typed errors instead of going stale', async () => {
    getCacheMock.mockResolvedValueOnce({
      content: ENTRY_YAML,
      proxy_count: 1,
      fetched_at: Date.now(),
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );

    const error = await resolveSubscriptionContent(makeSub(), { noCache: true }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(RemoteFetchAttemptError);
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

  it('can validate a fresh response without persisting it', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(ENTRY_YAML, { status: 200 }),
    );

    const result = await resolveSubscriptionContent(makeSub(), {
      writeCache: false,
      recordHealth: false,
    });

    expect(result.yaml).toContain('HK-01');
    expect(setCacheMock).not.toHaveBeenCalled();
  });

  it('treats a blank ua_override as unset and sends the default UA', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(ENTRY_YAML, { status: 200 }));

    await resolveSubscriptionContent(makeSub({ ua_override: '' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('clash.meta/1.18.0');
  });

  it('still honours a non-blank ua_override', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(ENTRY_YAML, { status: 200 }));

    await resolveSubscriptionContent(makeSub({ ua_override: 'custom-ua/9.9' }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('custom-ua/9.9');
  });
});
