import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CanonicalBase64urlSha256Schema,
  SubscriptionAdminViewSchema,
  SubscriptionCreateSchema,
  SubscriptionFetchFailureCategorySchema,
  SubscriptionFetchHealthSchema,
  SubscriptionSchema,
  SubscriptionUpdateSchema,
  effectiveFetchFailurePolicy,
} from '@/schemas';
import { SUBSCRIPTION_FETCH_FAILURE_CATEGORIES } from '@/lib/services/subscriptionResolutionErrors';

/** A real canonical unpadded base64url SHA-256 (43 chars). */
function computeCanonicalFingerprintSample(): string {
  return createHash('sha256').update('sample', 'utf8').digest('base64url');
}

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

describe('fetch failure policy — declarative remote-only field', () => {
  it('accepts both policy values on create and update, and rejects anything else', () => {
    expect(
      SubscriptionCreateSchema.parse({
        ...base,
        url: 'https://up.example/sub',
        fetch_failure_policy: 'use-stale-cache',
      }).fetch_failure_policy,
    ).toBe('use-stale-cache');
    expect(
      SubscriptionCreateSchema.parse({
        ...base,
        url: 'https://up.example/sub',
        fetch_failure_policy: 'fail-closed',
      }).fetch_failure_policy,
    ).toBe('fail-closed');
    expect(
      SubscriptionUpdateSchema.safeParse({ fetch_failure_policy: 'use-stale-cache' }).success,
    ).toBe(true);
    expect(
      SubscriptionUpdateSchema.safeParse({ fetch_failure_policy: 'fail-closed' }).success,
    ).toBe(true);
    expect(SubscriptionUpdateSchema.safeParse({ fetch_failure_policy: 'fallback' }).success).toBe(
      false,
    );
  });

  it('keeps the stored schema optional (legacy rows have no policy and are never rewritten)', () => {
    const stored = SubscriptionSchema.parse({
      id: '00000000-0000-4000-8000-000000000000',
      name: 'air',
      enabled: true,
      kind: 'remote',
      url: 'https://up.example/sub',
      ttl_ms: 60_000,
      tags: [],
    });
    expect(stored.fetch_failure_policy).toBeUndefined();
    // The effective-policy helper is remote-branch-only by contract; prove
    // the parsed legacy row is on that branch and yields the default.
    expect(stored.kind).toBe('remote');
    if (stored.kind === 'remote') {
      expect(effectiveFetchFailurePolicy(stored)).toBe('use-stale-cache');
    }

    const explicit = SubscriptionSchema.parse({ ...stored, fetch_failure_policy: 'fail-closed' });
    expect(explicit.fetch_failure_policy).toBe('fail-closed');
    if (explicit.kind === 'remote') {
      expect(effectiveFetchFailurePolicy(explicit)).toBe('fail-closed');
    }
  });

  it('stored rows carry the policy verbatim when present', () => {
    const parsed = SubscriptionSchema.parse({
      id: '00000000-0000-4000-8000-000000000000',
      name: 'air',
      enabled: true,
      kind: 'remote',
      url: 'https://up.example/sub',
      ttl_ms: 60_000,
      tags: [],
      fetch_failure_policy: 'fail-closed',
    });
    expect(parsed.fetch_failure_policy).toBe('fail-closed');
  });
});

describe('kind-discriminated stored schema (v2 I1)', () => {
  const baseRow = {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'air',
    enabled: true,
    url: 'https://up.example/sub',
    ttl_ms: 60_000,
    tags: [],
  };

  it('a remote stored row keeps an explicit policy; a missing policy stays absent', () => {
    const withPolicy = SubscriptionSchema.parse({
      ...baseRow,
      kind: 'remote',
      fetch_failure_policy: 'fail-closed',
    });
    expect(withPolicy.fetch_failure_policy).toBe('fail-closed');

    const withoutPolicy = SubscriptionSchema.parse({ ...baseRow, kind: 'remote' });
    expect(withoutPolicy.fetch_failure_policy).toBeUndefined();
  });

  it('a local stored row containing a legacy policy decodes with the field stripped in memory', () => {
    const parsed = SubscriptionSchema.parse({
      ...baseRow,
      kind: 'local',
      content: 'proxies: []\n',
      fetch_failure_policy: 'fail-closed',
    });
    expect(parsed.kind).toBe('local');
    expect(parsed.fetch_failure_policy).toBeUndefined();
    // The in-memory value is what any later declarative write would persist;
    // the raw Redis bytes themselves are untouched by decoding (repo-level).
  });

  it('a legacy row with a missing kind canonicalizes in memory to remote', () => {
    const legacy = SubscriptionSchema.parse({ ...baseRow });
    expect(legacy.kind).toBe('remote');
    expect(legacy.fetch_failure_policy).toBeUndefined();
    if (legacy.kind === 'remote') {
      expect(effectiveFetchFailurePolicy(legacy)).toBe('use-stale-cache');
    }
  });

  it('an invalid policy enum value keeps the existing unparseable-row behavior', () => {
    expect(
      SubscriptionSchema.safeParse({ ...baseRow, kind: 'remote', fetch_failure_policy: 'nope' })
        .success,
    ).toBe(false);
  });
});

describe('admin view — TRUE remote/local discriminated union (v2 F1)', () => {
  const viewBase = {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'air',
    display_name: '机场',
    enabled: true,
    url: 'https://up.example/sub',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    updated_at: 1,
  };

  it('the remote branch REQUIRES effective policy and nullable health', () => {
    expect(
      SubscriptionAdminViewSchema.safeParse({
        ...viewBase,
        kind: 'remote',
        fetch_failure_policy: 'use-stale-cache',
        fetch_health: null,
      }).success,
    ).toBe(true);
    // Missing policy or health fails the remote branch.
    expect(
      SubscriptionAdminViewSchema.safeParse({ ...viewBase, kind: 'remote', fetch_health: null })
        .success,
    ).toBe(false);
    expect(
      SubscriptionAdminViewSchema.safeParse({
        ...viewBase,
        kind: 'remote',
        fetch_failure_policy: 'fail-closed',
      }).success,
    ).toBe(false);
  });

  it('the local branch declares NEITHER policy nor health — inputs carrying them parse stripped', () => {
    const local = SubscriptionAdminViewSchema.parse({ ...viewBase, kind: 'local' });
    expect(local.kind).toBe('local');
    expect('fetch_failure_policy' in local).toBe(false);
    expect('fetch_health' in local).toBe(false);

    const stripped = SubscriptionAdminViewSchema.parse({
      ...viewBase,
      kind: 'local',
      fetch_failure_policy: 'fail-closed',
      fetch_health: null,
    });
    expect('fetch_failure_policy' in stripped).toBe(false);
    expect('fetch_health' in stripped).toBe(false);
  });
});

describe('health-union category enum matches the classifier enum (single source of truth)', () => {
  it('the schema-local category values equal the classifier enum exactly', () => {
    expect(SubscriptionFetchFailureCategorySchema.options).toEqual(
      SUBSCRIPTION_FETCH_FAILURE_CATEGORIES,
    );
  });
});

describe('canonical definition fingerprint scalar (v2 I12)', () => {
  // 32 zero bytes, base64url-unpadded — exactly 43 'A' characters.
  const CANONICAL = 'A'.repeat(43);

  it('accepts exactly one canonical unpadded base64url SHA-256', () => {
    expect(CanonicalBase64urlSha256Schema.safeParse(CANONICAL).success).toBe(true);
    expect(
      CanonicalBase64urlSha256Schema.safeParse(computeCanonicalFingerprintSample()).success,
    ).toBe(true);
  });

  it('rejects short, long, padded, foreign-alphabet and non-canonical trailing encodings', () => {
    const hostile = [
      ['short', 'A'.repeat(42)],
      ['long', 'A'.repeat(44)],
      ['padded', 'A'.repeat(42) + '='],
      ['plus alphabet', 'A'.repeat(42) + '+'],
      ['slash alphabet', 'A'.repeat(42) + '/'],
      // 42×A + 'B': the final character carries non-zero padding bits, so the
      // re-encoding is not byte-identical (non-canonical trailing bits).
      ['non-canonical trailing', 'A'.repeat(42) + 'B'],
      ['empty', ''],
    ] as const;
    for (const [label, value] of hostile) {
      expect(CanonicalBase64urlSha256Schema.safeParse(value).success, label).toBe(false);
    }
  });

  it('the health schema fingerprints are canonical and hostile values read null', () => {
    const base = {
      state: 'fresh',
      attempted_at: 1,
      observed_at: 2,
      fresh_at: 2,
      proxy_count: 1,
    };
    expect(
      SubscriptionFetchHealthSchema.safeParse({ ...base, definition_fingerprint: CANONICAL })
        .success,
    ).toBe(true);
    expect(
      SubscriptionFetchHealthSchema.safeParse({
        ...base,
        definition_fingerprint: 'A'.repeat(42) + 'B',
      }).success,
    ).toBe(false);
  });
});

describe('fetch health schema — state-discriminated and strict', () => {
  const baseHealth = {
    definition_fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    attempted_at: 1_700_000_000_000,
    observed_at: 1_700_000_000_001,
  };

  it('fresh requires fresh_at/proxy_count and forbids failure fields', () => {
    const fresh = SubscriptionFetchHealthSchema.parse({
      ...baseHealth,
      state: 'fresh',
      fresh_at: 1_700_000_000_001,
      proxy_count: 7,
      traffic: { upload: 1, download: 2, total: 3, expire: 4 },
    });
    expect(fresh.state).toBe('fresh');

    expect(SubscriptionFetchHealthSchema.safeParse({ ...baseHealth, state: 'fresh' }).success).toBe(
      false,
    );
    expect(
      SubscriptionFetchHealthSchema.safeParse({
        ...baseHealth,
        state: 'fresh',
        fresh_at: 1,
        failure_category: 'network',
      }).success,
    ).toBe(false);
  });

  it('stale-served requires fresh_at/category/served/cached proxy_count', () => {
    const stale = SubscriptionFetchHealthSchema.parse({
      ...baseHealth,
      state: 'stale-served',
      fresh_at: 1_600_000_000_000,
      failure_category: 'http',
      cache_disposition: 'served',
      proxy_count: 3,
    });
    expect(stale.state).toBe('stale-served');

    expect(
      SubscriptionFetchHealthSchema.safeParse({
        ...baseHealth,
        state: 'stale-served',
        fresh_at: 1,
        failure_category: 'http',
        proxy_count: 3,
      }).success,
    ).toBe(false);
    expect(
      SubscriptionFetchHealthSchema.safeParse({
        ...baseHealth,
        state: 'stale-served',
        fresh_at: 1,
        cache_disposition: 'served',
        proxy_count: 3,
      }).success,
    ).toBe(false);
  });

  it('failed-no-cache requires category plus a non-served disposition and omits proxy_count/traffic', () => {
    for (const disposition of ['unavailable', 'invalid', 'policy-blocked', 'bypassed'] as const) {
      const failed = SubscriptionFetchHealthSchema.parse({
        ...baseHealth,
        state: 'failed-no-cache',
        failure_category: 'network',
        cache_disposition: disposition,
      });
      expect(failed.state).toBe('failed-no-cache');
      expect('proxy_count' in failed).toBe(false);
      expect('traffic' in failed).toBe(false);
    }
    expect(
      SubscriptionFetchHealthSchema.safeParse({
        ...baseHealth,
        state: 'failed-no-cache',
        failure_category: 'network',
        cache_disposition: 'served',
      }).success,
    ).toBe(false);
    expect(
      SubscriptionFetchHealthSchema.safeParse({
        ...baseHealth,
        state: 'failed-no-cache',
        cache_disposition: 'unavailable',
      }).success,
    ).toBe(false);
    // malformed combination — a fresh record carrying failure fields — reads absent
    expect(
      SubscriptionFetchHealthSchema.safeParse({
        ...baseHealth,
        state: 'fresh',
        fresh_at: 1,
        proxy_count: 1,
        failure_category: 'network',
        cache_disposition: 'served',
      }).success,
    ).toBe(false);
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
