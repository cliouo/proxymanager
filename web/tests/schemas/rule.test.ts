import { describe, expect, it } from 'vitest';
import { RuleCreateSchema, RulePatchSchema, RuleReplaceSchema, RuleSchema } from '@/schemas';

const baseCreate = { anchor: 'manual', policy: '香港', source: 'manual' as const };

describe('RuleCreateSchema value/MATCH validation', () => {
  it('accepts a non-MATCH rule with a value', () => {
    const r = RuleCreateSchema.parse({ ...baseCreate, type: 'DOMAIN', value: 'example.com' });
    expect(r.value).toBe('example.com');
  });

  it('rejects a non-MATCH rule with an empty value', () => {
    expect(() => RuleCreateSchema.parse({ ...baseCreate, type: 'DOMAIN', value: '' })).toThrow();
    expect(() => RuleCreateSchema.parse({ ...baseCreate, type: 'IP-CIDR', value: '   ' })).toThrow();
  });

  it('accepts MATCH with no value (defaults to empty string)', () => {
    const r = RuleCreateSchema.parse({ anchor: 'late', policy: '默认', source: 'manual', type: 'MATCH' });
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
});

describe('RuleReplaceSchema', () => {
  it('enforces the same value/MATCH rule', () => {
    expect(() =>
      RuleReplaceSchema.parse({ anchor: 'manual', type: 'DOMAIN', value: '', policy: '香港', rank: 10, source: 'manual' }),
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
