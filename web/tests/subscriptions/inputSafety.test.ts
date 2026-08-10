import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsError } from '@/lib/http/problem';
import { readCapped } from '@/lib/net/safeFetch';
import { MAX_SUBSCRIPTION_CONTENT } from '@/schemas/base';
import { MAX_REMOTE_SUBSCRIPTION_BODY_BYTES } from '@/lib/repos/fetchCacheRepo';
import { fetchSubscription, parseTrafficHeader } from '@/lib/services/subscriptionFetcher';
import { SubscriptionSchema, SubscriptionTrafficSchema } from '@/schemas/subscription';

const MAX_SUBSCRIPTION_BODY_BYTES = MAX_REMOTE_SUBSCRIPTION_BODY_BYTES;
const PROVIDER_PREFIX = `proxies:
  - name: SAFE-FAKE
    type: ss
    server: edge.invalid
    port: 8388
    cipher: aes-128-gcm
    password: FAKE_ONLY
`;

describe('readCapped completeness boundary', () => {
  it('does not mark an exact-cap stream as truncated', async () => {
    const result = await readCapped(new Response(new Uint8Array([1, 2, 3, 4])), 4);

    expect([...result.buf]).toEqual([1, 2, 3, 4]);
    expect(result.truncated).toBe(false);
  });

  it('marks cap-plus-one as truncated without returning the extra byte', async () => {
    const result = await readCapped(new Response(new Uint8Array([1, 2, 3, 4, 5])), 4);

    expect([...result.buf]).toEqual([1, 2, 3, 4]);
    expect(result.truncated).toBe(true);
  });
});

describe('readCapped v2 body-transport boundary (I3)', () => {
  /** Minimal body whose reader.read rejects the returned promise. */
  function rejectingReader(error: unknown): ReadableStream<Uint8Array> {
    return {
      getReader: () => ({
        read: () => Promise.reject(error),
        cancel: () => Promise.resolve(),
      }),
    } as unknown as ReadableStream<Uint8Array>;
  }

  it('invokes onTransportRejection only for a reader.read PROMISE rejection', async () => {
    const fault = new Error('stream broke');
    const onTransportRejection = vi.fn(() => {
      throw fault;
    });
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: rejectingReader(fault),
      configurable: true,
    });

    await expect(
      readCapped(res, 100, onTransportRejection as unknown as (error: unknown) => never),
    ).rejects.toBe(fault);
    expect(onTransportRejection).toHaveBeenCalledTimes(1);
    expect(onTransportRejection).toHaveBeenCalledWith(fault);
  });

  it('a synchronous reader.read INVOCATION fault preserves exact identity (no callback)', async () => {
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
    const onTransportRejection = vi.fn();

    await expect(
      readCapped(res, 100, onTransportRejection as unknown as (error: unknown) => never),
    ).rejects.toBe(syncFault);
    expect(onTransportRejection).not.toHaveBeenCalled();
  });

  it('a synchronous response.body access fault preserves exact identity (no callback)', async () => {
    const bodyFault = new Error('body getter fault');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      get() {
        throw bodyFault;
      },
      configurable: true,
    });
    const onTransportRejection = vi.fn();

    await expect(
      readCapped(res, 100, onTransportRejection as unknown as (error: unknown) => never),
    ).rejects.toBe(bodyFault);
    expect(onTransportRejection).not.toHaveBeenCalled();
  });

  it('a post-resolution CHUNK access fault preserves exact identity (no callback)', async () => {
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
    const onTransportRejection = vi.fn();

    await expect(
      readCapped(res, 100, onTransportRejection as unknown as (error: unknown) => never),
    ).rejects.toBe(chunkFault);
    expect(onTransportRejection).not.toHaveBeenCalled();
  });

  it('a SYNCHRONOUS AbortError from the response.body getter keeps identity (not timeout, no callback)', async () => {
    const abort = new DOMException('body getter aborted', 'AbortError');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      get() {
        throw abort;
      },
      configurable: true,
    });
    const onTransportRejection = vi.fn();

    await expect(
      readCapped(res, 100, onTransportRejection as unknown as (error: unknown) => never),
    ).rejects.toBe(abort);
    expect(onTransportRejection).not.toHaveBeenCalled();
  });

  it('a SYNCHRONOUS AbortError from getReader keeps identity (not timeout, no callback)', async () => {
    const abort = new DOMException('getReader aborted', 'AbortError');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: {
        getReader() {
          throw abort;
        },
      },
      configurable: true,
    });
    const onTransportRejection = vi.fn();

    await expect(
      readCapped(res, 100, onTransportRejection as unknown as (error: unknown) => never),
    ).rejects.toBe(abort);
    expect(onTransportRejection).not.toHaveBeenCalled();
  });

  it('a post-resolution FINAL-ASSEMBLY fault keeps identity (no callback)', async () => {
    const assemblyFault = new Error('assembly length fault');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: {
        getReader: () => ({
          // ONE poisoned chunk, then done — so the loop exits and the FINAL
          // buffer assembly (buf.set reads `length`) touches the getter.
          read: vi
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: {
                byteLength: 4,
                get length() {
                  throw assemblyFault;
                },
              },
            })
            .mockResolvedValueOnce({ done: true }),
          cancel: () => Promise.resolve(),
        }),
      },
      configurable: true,
    });
    const onTransportRejection = vi.fn();

    await expect(
      readCapped(res, 100, onTransportRejection as unknown as (error: unknown) => never),
    ).rejects.toBe(assemblyFault);
    expect(onTransportRejection).not.toHaveBeenCalled();
  });

  it('arrayBuffer PROMISE rejection invokes the callback; synchronous invocation faults do not', async () => {
    const transport = new Error('arrayBuffer transport broke');
    const noBodyRes = new Response(null, { status: 200 });
    Object.defineProperty(noBodyRes, 'body', { value: null, configurable: true });
    Object.defineProperty(noBodyRes, 'arrayBuffer', {
      value: () => Promise.reject(transport),
      configurable: true,
    });
    const onTransport = vi.fn(() => {
      throw transport;
    });
    await expect(readCapped(noBodyRes, 100, onTransport as (error: unknown) => never)).rejects.toBe(
      transport,
    );
    expect(onTransport).toHaveBeenCalledTimes(1);

    const syncFault = new Error('arrayBuffer invocation fault');
    const syncRes = new Response(null, { status: 200 });
    Object.defineProperty(syncRes, 'body', { value: null, configurable: true });
    Object.defineProperty(syncRes, 'arrayBuffer', {
      value: () => {
        throw syncFault;
      },
      configurable: true,
    });
    const onTransport2 = vi.fn();
    await expect(
      readCapped(syncRes, 100, onTransport2 as unknown as (error: unknown) => never),
    ).rejects.toBe(syncFault);
    expect(onTransport2).not.toHaveBeenCalled();
  });

  it('callers that omit the callback keep the original rejection (behavior preserved)', async () => {
    const fault = new Error('stream broke');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: rejectingReader(fault),
      configurable: true,
    });

    await expect(readCapped(res, 100)).rejects.toBe(fault);
  });
});

describe('remote subscription input safety', () => {
  it('keeps the 10 MiB server fetch limit independent from 4 MiB manual uploads', () => {
    expect(MAX_SUBSCRIPTION_BODY_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_SUBSCRIPTION_CONTENT).toBe(4 * 1024 * 1024);
  });

  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('rejects a declared Content-Length above the body limit with the fixed category sentence', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(PROVIDER_PREFIX, {
        status: 200,
        headers: { 'content-length': String(MAX_SUBSCRIPTION_BODY_BYTES + 1) },
      }),
    );

    // P-FFP v1: oversize fresh bytes are a typed response-content-format
    // outcome with the FIXED safe message — the raw byte count is never echoed.
    const error = await fetchSubscription('https://upstream.invalid/sub').catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ category: 'response-content-format' });
    expect((error as Error).message).toBe('Upstream response content is not a valid subscription');
  });

  it('accepts a complete, valid subscription whose body is exactly at the limit', async () => {
    const prefix = `${PROVIDER_PREFIX}#`;
    const body = `${prefix}${'x'.repeat(MAX_SUBSCRIPTION_BODY_BYTES - prefix.length)}`;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { 'content-length': String(MAX_SUBSCRIPTION_BODY_BYTES) },
      }),
    );

    const result = await fetchSubscription('https://upstream.invalid/sub');

    expect(result.proxyCount).toBe(1);
  });

  it('rejects a chunked cap-plus-one body instead of normalising its valid prefix', async () => {
    const prefix = new TextEncoder().encode(`${PROVIDER_PREFIX}#`);
    const filler = new Uint8Array(MAX_SUBSCRIPTION_BODY_BYTES - prefix.byteLength);
    filler.fill('x'.charCodeAt(0));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
        controller.enqueue(filler);
        controller.enqueue(new Uint8Array(['x'.charCodeAt(0)]));
        controller.close();
      },
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(body, { status: 200 }),
    );

    // P-FFP v1: a truncated fresh body is a typed response-content-format
    // outcome with the FIXED safe message.
    const error = await fetchSubscription('https://upstream.invalid/sub').catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ category: 'response-content-format' });
    expect((error as Error).message).toBe('Upstream response content is not a valid subscription');
  });

  it('rejects malformed UTF-8 with a credential-free error', async () => {
    const encoder = new TextEncoder();
    const [prefixBeforePassword, prefixAfterPassword] = PROVIDER_PREFIX.split('FAKE_ONLY');
    const before = encoder.encode(`${prefixBeforePassword}FAKE_`);
    const after = encoder.encode(`_DO_NOT_USE${prefixAfterPassword}`);
    const bytes = new Uint8Array(before.byteLength + 1 + after.byteLength);
    bytes.set(before);
    bytes[before.byteLength] = 0xff;
    bytes.set(after, before.byteLength + 1);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(bytes, { status: 200 }),
    );

    expect.assertions(5);
    await fetchSubscription('https://upstream.invalid/sub').catch((error: unknown) => {
      expect(error).toBeInstanceOf(ProblemDetailsError);
      // P-FFP v1: fatal decode of fresh bytes is a typed response-encoding
      // outcome with the FIXED safe message.
      expect(error).toMatchObject({ category: 'response-encoding' });
      expect((error as Error).message).toBe('Upstream response is not valid UTF-8');
      expect((error as Error).message).not.toContain('FAKE_');
      expect((error as Error).message).not.toContain('\uFFFD');
    });
  });

  it('continues to accept valid multibyte UTF-8', async () => {
    const body = PROVIDER_PREFIX.replace('FAKE_ONLY', 'FAKE_🔐_ONLY');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(body, { status: 200 }),
    );

    const result = await fetchSubscription('https://upstream.invalid/sub');

    expect(result.proxyCount).toBe(1);
    expect(result.yaml).toContain('FAKE_🔐_ONLY');
  });

  it('rejects URL userinfo before fetch without echoing credentials', async () => {
    const sentinel = 'FAKE_URL_SECRET_DO_NOT_USE';
    let thrown: unknown;
    try {
      await fetchSubscription(`https://fake-user:${sentinel}@upstream.invalid/sub`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProblemDetailsError);
    expect((thrown as Error).message).toBe('Upstream subscription URL must not contain userinfo');
    expect((thrown as Error).message).not.toContain(sentinel);
    expect((thrown as Error).message).not.toContain('fake-user');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps a reader.read PROMISE rejection to network (503, fixed text)', async () => {
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

    const error = await fetchSubscription('https://upstream.invalid/sub').catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ category: 'network' });
    expect((error as ProblemDetailsError).problem.status).toBe(503);
    expect((error as Error).message).toBe('Upstream fetch failed');
  });

  it('maps a reader.read PROMISE AbortError to timeout (503, fixed text)', async () => {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: {
        getReader: () => ({
          read: () => Promise.reject(new DOMException('aborted', 'AbortError')),
          cancel: () => Promise.resolve(),
        }),
      },
      configurable: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(res);

    const error = await fetchSubscription('https://upstream.invalid/sub').catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ category: 'timeout' });
    expect((error as Error).message).toBe('Upstream fetch timed out');
  });

  it('a synchronous reader.read invocation fault stays a generic identity error', async () => {
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

    const error = await fetchSubscription('https://upstream.invalid/sub').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBe(syncFault);
  });

  it('a post-resolution chunk fault stays a generic identity error', async () => {
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

    const error = await fetchSubscription('https://upstream.invalid/sub').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBe(chunkFault);
  });

  it('does not forward fetch diagnostics containing URL or header credentials', async () => {
    const sentinels = [
      'FAKE_PATH_SECRET_DO_NOT_USE',
      'FAKE_QUERY_SECRET_DO_NOT_USE',
      'FAKE_HEADER_SECRET_DO_NOT_USE',
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(`network error ${sentinels.join(' ')}`),
    );
    let thrown: unknown;
    try {
      await fetchSubscription(`https://upstream.invalid/${sentinels[0]}?token=${sentinels[1]}`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProblemDetailsError);
    expect((thrown as Error).message).toBe('Upstream fetch failed');
    for (const sentinel of sentinels) {
      expect((thrown as Error).message).not.toContain(sentinel);
    }
  });
});

describe('Subscription-Userinfo schema boundary', () => {
  it('drops metadata when a counter or expiry violates the persisted schema', () => {
    const traffic = parseTrafficHeader('upload=-1; download=2; total=3; expire=4.5');

    expect(traffic).toBeUndefined();
    // Traffic now lives only inside the separate fetch-health value; a legacy
    // `last_traffic` key on a stored row is runtime state and parses away.
    expect(
      SubscriptionSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000000',
        name: 'safe-fake',
        enabled: true,
        kind: 'remote',
        url: 'https://upstream.invalid/sub',
        last_traffic: traffic,
      }).success,
    ).toBe(true);
  });

  it('ignores unknown metadata fields and returns undefined when none are recognised', () => {
    expect(parseTrafficHeader('vendor-credit=10; reset-day=1')).toBeUndefined();
    expect(parseTrafficHeader('vendor-credit=10; download=2')).toEqual({
      upload: 0,
      download: 2,
      total: 0,
      expire: 0,
    });
  });

  it('returns only values accepted by SubscriptionTrafficSchema', () => {
    const allowed = parseTrafficHeader('upload=1.5; download=0; total=3; expire=-1');

    expect(allowed).toEqual({ upload: 1.5, download: 0, total: 3, expire: -1 });
    expect(SubscriptionTrafficSchema.safeParse(allowed).success).toBe(true);
    expect(parseTrafficHeader('upload=1; expire=Infinity')).toBeUndefined();
  });
});
