import { describe, expect, it } from 'vitest';
import { SubscriptionCreateSchema } from '@/schemas';

const base = { name: 'air', kind: 'remote' as const };

describe('subscription URL scheme + content cap (P3-19 / P3-17)', () => {
  it('accepts an https upstream URL', () => {
    const r = SubscriptionCreateSchema.parse({ ...base, url: 'https://up.example/sub' });
    expect(r.url).toBe('https://up.example/sub');
  });

  it('rejects a non-http(s) scheme (SSRF footgun)', () => {
    expect(() => SubscriptionCreateSchema.parse({ ...base, url: 'file:///etc/passwd' })).toThrow();
    expect(() => SubscriptionCreateSchema.parse({ ...base, url: 'gopher://internal/' })).toThrow();
  });

  it('rejects URL userinfo without retaining it in the validation message', () => {
    const sentinel = 'FAKE_URL_PASSWORD_DO_NOT_USE';
    const result = SubscriptionCreateSchema.safeParse({
      ...base,
      url: `https://fake-user:${sentinel}@up.example/sub`,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).not.toContain(sentinel);
      expect(result.error.message).not.toContain('fake-user');
    }
  });

  it('rejects local content over the size cap', () => {
    const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
    expect(() =>
      SubscriptionCreateSchema.parse({ name: 'air', kind: 'local', content: huge }),
    ).toThrow();
  });
});
