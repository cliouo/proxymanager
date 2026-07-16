import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsError } from '@/lib/http/problem';
import { readCapped } from '@/lib/net/safeFetch';
import { fetchSubscription, parseTrafficHeader } from '@/lib/services/subscriptionFetcher';
import { SubscriptionSchema, SubscriptionTrafficSchema } from '@/schemas/subscription';

const MAX_SUBSCRIPTION_BODY_BYTES = 10 * 1024 * 1024;
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

describe('remote subscription input safety', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('rejects a declared Content-Length above the body limit', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(PROVIDER_PREFIX, {
        status: 200,
        headers: { 'content-length': String(MAX_SUBSCRIPTION_BODY_BYTES + 1) },
      }),
    );

    await expect(fetchSubscription('https://upstream.invalid/sub')).rejects.toThrow(
      /body exceeds 10485760 bytes/,
    );
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

    await expect(fetchSubscription('https://upstream.invalid/sub')).rejects.toThrow(
      /body exceeds 10485760 bytes/,
    );
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

    expect.assertions(4);
    await fetchSubscription('https://upstream.invalid/sub').catch((error: unknown) => {
      expect(error).toBeInstanceOf(ProblemDetailsError);
      expect((error as Error).message).toBe('Upstream subscription body is not valid UTF-8');
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
