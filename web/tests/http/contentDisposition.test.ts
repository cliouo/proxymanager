import { describe, expect, it } from 'vitest';
import { attachmentDisposition } from '@/lib/http/contentDisposition';

describe('attachmentDisposition', () => {
  it('keeps plain ASCII names as-is in both forms', () => {
    expect(attachmentDisposition('proxymanager-default.yaml')).toBe(
      'attachment; filename="proxymanager-default.yaml"; filename*=UTF-8\'\'proxymanager-default.yaml',
    );
  });

  it('percent-encodes non-ASCII into filename* and sanitises the ASCII fallback', () => {
    const out = attachmentDisposition('家庭主力.yaml');
    expect(out).toContain("filename*=UTF-8''%E5%AE%B6%E5%BA%AD%E4%B8%BB%E5%8A%9B.yaml");
    // ASCII fallback replaces each non-printable byte with `_`.
    expect(out).toContain('filename="____.yaml"');
  });

  it('neutralises quotes and backslashes that would break the quoted-string', () => {
    const out = attachmentDisposition('a"b\\c.yaml');
    expect(out).toContain('filename="a_b_c.yaml"');
    // filename* carries the real characters, percent-encoded.
    expect(out).toContain("filename*=UTF-8''a%22b%5Cc.yaml");
  });
});
