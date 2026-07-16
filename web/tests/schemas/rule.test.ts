import { describe, expect, it } from 'vitest';
import { RuleCreateSchema, RulePatchSchema, RuleReplaceSchema, RuleSchema } from '@/schemas';
import { assertMergedRuleRenderable } from '@/schemas/rule';

const baseCreate = { anchor: 'manual', policy: '香港', source: 'manual' as const };

describe('RuleCreateSchema value/MATCH validation', () => {
  it('accepts a non-MATCH rule with a value', () => {
    const r = RuleCreateSchema.parse({ ...baseCreate, type: 'DOMAIN', value: 'example.com' });
    expect(r.value).toBe('example.com');
  });

  it('rejects a non-MATCH rule with an empty value', () => {
    expect(() => RuleCreateSchema.parse({ ...baseCreate, type: 'DOMAIN', value: '' })).toThrow();
    expect(() =>
      RuleCreateSchema.parse({ ...baseCreate, type: 'IP-CIDR', value: '   ' }),
    ).toThrow();
  });

  it('accepts MATCH with no value (defaults to empty string)', () => {
    const r = RuleCreateSchema.parse({
      anchor: 'late',
      policy: '默认',
      source: 'manual',
      type: 'MATCH',
    });
    expect(r.type).toBe('MATCH');
    expect(r.value).toBe('');
  });

  it('carries options and enabled through', () => {
    const r = RuleCreateSchema.parse({
      ...baseCreate,
      type: 'GEOIP',
      value: 'lan',
      policy: '直连',
      options: ['no-resolve'],
      enabled: false,
    });
    expect(r.options).toEqual(['no-resolve']);
    expect(r.enabled).toBe(false);
  });

  it('rejects comma field reordering, ignored params, and invalid typed payloads', () => {
    for (const candidate of [
      { ...baseCreate, type: 'DOMAIN' as const, value: 'foo,DIRECT' },
      { ...baseCreate, type: 'DOMAIN' as const, value: 'foo', policy: 'DIRECT,REJECT' },
      { ...baseCreate, type: 'DOMAIN' as const, value: 'foo', options: ['no-resolve'] },
      { ...baseCreate, type: 'IP-CIDR' as const, value: 'not-a-cidr' },
      { ...baseCreate, type: 'IP-CIDR' as const, value: '192.0.2.0/024' },
      { ...baseCreate, type: 'IP-CIDR6' as const, value: '1.2.3.4::/64' },
      { ...baseCreate, type: 'DST-PORT' as const, value: '65536' },
      { ...baseCreate, type: 'NETWORK' as const, value: 'QUIC' },
      { ...baseCreate, type: 'IP-ASN' as const, value: 'AS13335' },
    ]) {
      expect(RuleCreateSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('accepts only the safe shared regexp2 subset and forbids regex options', () => {
    expect(
      RuleCreateSchema.safeParse({
        ...baseCreate,
        type: 'DOMAIN-REGEX',
        value: 'foo,(?=bar)',
      }).success,
    ).toBe(true);
    for (const candidate of [
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '[]' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '[^]' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '^\\u{1F600}$' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '(a|A)+$' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '(K|KK)+$' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '(ß|\\u1E9Eß)+$' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '(K|[℀-∀]K)+$' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '(K|[\\u2100-\\u2200]K)+$' },
      { ...baseCreate, type: 'DOMAIN-REGEX' as const, value: '^foo, bar$' },
      {
        ...baseCreate,
        type: 'DOMAIN-REGEX' as const,
        value: 'foo',
        options: ['DIRECT'],
      },
    ]) {
      expect(RuleCreateSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe('RuleReplaceSchema', () => {
  it('enforces the same value/MATCH rule', () => {
    expect(() =>
      RuleReplaceSchema.parse({
        anchor: 'manual',
        type: 'DOMAIN',
        value: '',
        policy: '香港',
        rank: 10,
        source: 'manual',
      }),
    ).toThrow();
    const ok = RuleReplaceSchema.parse({
      anchor: 'late',
      type: 'MATCH',
      policy: '默认',
      rank: 999,
      source: 'manual',
    });
    expect(ok.value).toBe('');
  });
});

describe('RuleSchema backward compatibility', () => {
  it('parses a legacy stored rule without options/enabled', () => {
    const r = RuleSchema.parse({
      id: '00000000-0000-0000-0000-000000000000',
      anchor: 'manual',
      type: 'DOMAIN-SUFFIX',
      value: 'emby.media',
      policy: '香港',
      rank: 100,
      source: 'import',
      added_at: 1716000000,
      updated_at: 1716000000,
    });
    expect(r.options).toBeUndefined();
    expect(r.enabled).toBeUndefined();
  });
});

describe('RulePatchSchema', () => {
  it('allows toggling enabled and editing options without other fields', () => {
    expect(RulePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(RulePatchSchema.parse({ options: ['no-resolve'] })).toEqual({ options: ['no-resolve'] });
  });
});

/* ─── P2-4: YAML-injection guard on the rendered rule line ──────────── */

describe('rule value/policy YAML-safety (P2-4)', () => {
  it('rejects a newline in the value (would smuggle a second rule)', () => {
    expect(() =>
      RuleCreateSchema.parse({
        ...baseCreate,
        type: 'DOMAIN',
        value: 'a.com\n  - MATCH,REJECT',
      }),
    ).toThrow();
  });

  it('rejects a ": " map trigger in the value (reparses the entry into a map)', () => {
    expect(() =>
      RuleCreateSchema.parse({ ...baseCreate, type: 'DOMAIN', value: 'foo, bar: baz' }),
    ).toThrow();
  });

  it('rejects a control character in the policy', () => {
    expect(() =>
      RuleCreateSchema.parse({ ...baseCreate, type: 'DOMAIN', value: 'a.com', policy: 'x\ty' }),
    ).toThrow();
  });

  it('still accepts an IPv6 IP-CIDR value (colon without a following space)', () => {
    const r = RuleCreateSchema.parse({
      ...baseCreate,
      type: 'IP-CIDR6',
      value: '2001:db8::/32',
      policy: '直连',
      options: ['no-resolve'],
    });
    expect(r.value).toBe('2001:db8::/32');
  });
});

/* ─── P2-3: merged PATCH must re-validate value/injection ───────────── */

describe('assertMergedRuleRenderable (P2-3)', () => {
  const base = {
    anchor: 'manual',
    type: 'DOMAIN',
    value: 'example.com',
    policy: '香港',
    rank: 10,
    source: 'manual',
  };

  it('accepts a valid merged rule', () => {
    expect(() => assertMergedRuleRenderable(base)).not.toThrow();
  });

  it('rejects a PATCH that empties a non-MATCH value', () => {
    expect(() => assertMergedRuleRenderable({ ...base, value: '' })).toThrow();
  });

  it('rejects a PATCH that injects a newline into the value', () => {
    expect(() => assertMergedRuleRenderable({ ...base, value: 'a\n- MATCH,REJECT' })).toThrow();
  });
});
