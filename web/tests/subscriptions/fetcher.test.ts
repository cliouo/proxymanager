import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSubscription,
  normaliseToClashProviderYaml,
  parseTrafficHeader,
} from '@/lib/services/subscriptionFetcher';
import { ProblemDetailsError } from '@/lib/http/problem';
import { SubscriptionContentValidationError } from '@/lib/services/subscriptionResolutionErrors';

const SAMPLE_CLASH_YAML = `# A bare-bones airport response
mixed-port: 7890
proxies:
  - name: HK-01
    type: vmess
    server: hk.example.com
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
    cipher: auto
  - name: JP-02
    type: trojan
    server: jp.example.com
    port: 443
    password: secret
rules:
  - MATCH,DIRECT
`;

const SAMPLE_PROXIES_ONLY = `proxies:
  - { name: US-01, type: ss, server: us.example.com, port: 8388, cipher: chacha20-ietf-poly1305, password: s }
`;

describe('parseTrafficHeader', () => {
  it('parses standard Subscription-Userinfo', () => {
    expect(
      parseTrafficHeader('upload=1024; download=2048; total=1000000; expire=1700000000'),
    ).toEqual({ upload: 1024, download: 2048, total: 1000000, expire: 1700000000 });
  });

  it('handles missing fields as zero', () => {
    expect(parseTrafficHeader('download=2048')).toEqual({
      upload: 0,
      download: 2048,
      total: 0,
      expire: 0,
    });
  });

  it('returns undefined for null/empty', () => {
    expect(parseTrafficHeader(null)).toBeUndefined();
    expect(parseTrafficHeader('')).toBeUndefined();
    expect(parseTrafficHeader('   ')).toBeUndefined();
  });
});

describe('normaliseToClashProviderYaml', () => {
  it('extracts proxies from a full Clash config', () => {
    const result = normaliseToClashProviderYaml(SAMPLE_CLASH_YAML);
    expect(result.proxyCount).toBe(2);
    expect(result.yaml).toContain('HK-01');
    expect(result.yaml).toContain('JP-02');
    expect(result.yaml).not.toContain('mixed-port');
    expect(result.yaml).not.toContain('MATCH');
  });

  it('passes through a proxies-only document', () => {
    const result = normaliseToClashProviderYaml(SAMPLE_PROXIES_ONLY);
    expect(result.proxyCount).toBe(1);
    expect(result.yaml).toContain('US-01');
  });

  // P3-12: some airports base64-wrap a FULL Clash YAML config (not a URI list).
  it('decodes a base64-wrapped full Clash YAML config', () => {
    const wrapped = Buffer.from(SAMPLE_CLASH_YAML, 'utf-8').toString('base64');
    const result = normaliseToClashProviderYaml(wrapped);
    expect(result.proxyCount).toBe(2);
    expect(result.yaml).toContain('HK-01');
    expect(result.yaml).toContain('JP-02');
    expect(result.yaml).not.toContain('mixed-port');
  });

  it('decodes a base64-wrapped proxies-only document', () => {
    const wrapped = Buffer.from(SAMPLE_PROXIES_ONLY, 'utf-8').toString('base64');
    const result = normaliseToClashProviderYaml(wrapped);
    expect(result.proxyCount).toBe(1);
    expect(result.yaml).toContain('US-01');
  });

  it('throws ProblemDetailsError on invalid yaml', () => {
    expect(() => normaliseToClashProviderYaml('proxies:\n  - {{{')).toThrow(ProblemDetailsError);
  });

  it('throws when proxies key is missing', () => {
    expect(() => normaliseToClashProviderYaml('mixed-port: 7890\n')).toThrow(ProblemDetailsError);
  });

  it('throws on empty input', () => {
    expect(() => normaliseToClashProviderYaml('')).toThrow(ProblemDetailsError);
  });

  it('exposes only structured, credential-free URI-list diagnostics', () => {
    const marker = 'juicity-fakesecretmarker';
    let error: unknown;
    try {
      normaliseToClashProviderYaml(
        `trojan://safe@example.invalid:443#valid\n${marker}://credential@example.invalid:443#bad`,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SubscriptionContentValidationError);
    expect((error as SubscriptionContentValidationError).contentIssue).toEqual({
      kind: 'uri_list_invalid',
      failed: 1,
      total: 2,
      samples: [
        {
          category: 'unsupported_scheme',
          line: 2,
        },
      ],
    });
    expect((error as Error).message).not.toContain(marker);
    expect(
      JSON.stringify((error as SubscriptionContentValidationError).contentIssue),
    ).not.toContain(marker);
  });
});

describe('fetchSubscription', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns yaml + traffic on a 200 with Subscription-Userinfo', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(SAMPLE_CLASH_YAML, {
        status: 200,
        headers: {
          'subscription-userinfo': 'upload=10; download=20; total=30; expire=40',
        },
      }),
    );

    const result = await fetchSubscription('https://upstream.example/sub');
    expect(result.proxyCount).toBe(2);
    expect(result.traffic).toEqual({ upload: 10, download: 20, total: 30, expire: 40 });
    expect(result.yaml).toContain('HK-01');
  });

  it('forwards a custom User-Agent', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(SAMPLE_PROXIES_ONLY, { status: 200 }));

    await fetchSubscription('https://upstream.example/sub', { userAgent: 'custom-ua/1.0' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('custom-ua/1.0');
  });

  it('throws on non-OK upstream', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('nope', { status: 502 }),
    );

    await expect(fetchSubscription('https://upstream.example/sub')).rejects.toThrow(
      ProblemDetailsError,
    );
  });
});
