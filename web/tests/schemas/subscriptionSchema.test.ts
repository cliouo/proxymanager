import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SubscriptionCreateSchema, SubscriptionUpdateSchema } from '@/schemas';

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

describe('subscription rename — documented identity reset (not a migration)', () => {
  it('the update schema permits renaming the identifier', () => {
    const parsed = SubscriptionUpdateSchema.safeParse({ name: 'new-name' });
    expect(parsed.success).toBe(true);
  });

  it('the stable-slug comment and the reachable edit helper copy warn that rename breaks old distribution links and resets naming aliases/ordinals', () => {
    const schemaSource = readFileSync(
      new URL('../../schemas/subscription.ts', import.meta.url),
      'utf8',
    );
    // the old affirmative "remains the stable slug identifier" claim is
    // gone; the identity-reset warning names the consequences
    expect(schemaSource).not.toMatch(/remains the stable slug identifier/);
    expect(schemaSource).toMatch(/IDENTITY RESET/);
    expect(schemaSource).toMatch(/distribution links/);
    expect(schemaSource).toMatch(/aliases/);
    expect(schemaSource).toMatch(/ordinals/);

    const pageSource = readFileSync(
      new URL('../../app/(authed)/subscriptions/page.tsx', import.meta.url),
      'utf8',
    );
    expect(pageSource).toMatch(/改名（API）会断开旧分发链接/);
    expect(pageSource).toMatch(/命名别名/);
    expect(pageSource).toMatch(/序号/);
  });
});
