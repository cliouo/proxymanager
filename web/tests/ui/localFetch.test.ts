import { describe, expect, it } from 'vitest';
import type { SubscriptionLocalFetchSpec } from '@/schemas';
import {
  checkNativeFetchCompatibility,
  decodeUtf8,
  LocalFetchError,
  MAX_MANUAL_CONTENT,
} from '@/ui/data/local-fetch';

const UA = 'Mozilla/5.0 Test';

function spec(partial: Partial<SubscriptionLocalFetchSpec> = {}): SubscriptionLocalFetchSpec {
  return {
    subscriptionId: '00000000-0000-4000-8000-000000000001',
    url: 'https://airport.example/sub?token=abc',
    userAgent: UA,
    customHeaders: {},
    updatedAt: 1,
    fetchIdentityRevision: 0,
    ...partial,
  };
}

const env = { pageProtocol: 'https:', navigatorUserAgent: UA };

describe('checkNativeFetchCompatibility', () => {
  it('accepts a request the browser can reproduce exactly', () => {
    expect(checkNativeFetchCompatibility(spec({ customHeaders: { 'X-Token': 'a' } }), env)).toBeNull();
  });

  it('rejects anything the browser would send differently', () => {
    expect(checkNativeFetchCompatibility(spec({ url: 'ftp://x.example/a' }), env)).toBe('unsupported-url');
    expect(checkNativeFetchCompatibility(spec({ url: 'http://x.example/a' }), env)).toBe('mixed-content');
    expect(checkNativeFetchCompatibility(spec({ url: 'http://x.example/a' }), { ...env, pageProtocol: 'http:' })).toBeNull();
    expect(checkNativeFetchCompatibility(spec({ userAgent: 'clash.meta/1.18.0' }), env)).toBe('user-agent-mismatch');
    expect(checkNativeFetchCompatibility(spec({ customHeaders: { Cookie: 'a=b' } }), env)).toBe('forbidden-header');
    expect(checkNativeFetchCompatibility(spec({ customHeaders: { 'Sec-Fetch-Mode': 'x' } }), env)).toBe('forbidden-header');
    expect(
      checkNativeFetchCompatibility(spec({ customHeaders: { 'X-HTTP-Method-Override': 'TRACE' } }), env),
    ).toBe('forbidden-header');
  });
});

describe('decodeUtf8', () => {
  it('decodes valid UTF-8', () => {
    expect(decodeUtf8(new TextEncoder().encode('proxies: []\n# 节点').buffer)).toBe('proxies: []\n# 节点');
  });

  it('rejects invalid bytes and oversize bodies with typed errors', () => {
    expect(() => decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd]).buffer)).toThrow(LocalFetchError);
    try {
      decodeUtf8(new ArrayBuffer(MAX_MANUAL_CONTENT + 1));
    } catch (error) {
      expect((error as LocalFetchError).code).toBe('too-large');
    }
  });
});
