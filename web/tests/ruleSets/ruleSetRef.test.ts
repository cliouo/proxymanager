import { describe, expect, it, vi } from 'vitest';

// rulesService transitively imports the redis-backed repos; stub the client so
// the module loads without a live connection. ensureValidRuleSetRef is pure.
vi.mock('@/lib/redis/client', () => ({ getRedis: () => ({}) }));

const { ensureValidRuleSetRef } = await import('@/lib/services/rulesService');

describe('ensureValidRuleSetRef', () => {
  const names = new Set(['cn_domain', 'ads']);

  it('is a no-op for non RULE-SET rules', () => {
    expect(() => ensureValidRuleSetRef({ type: 'DOMAIN', value: 'whatever' }, names)).not.toThrow();
  });

  it('accepts a RULE-SET rule pointing at a library entry', () => {
    expect(() => ensureValidRuleSetRef({ type: 'RULE-SET', value: 'cn_domain' }, names)).not.toThrow();
  });

  it('rejects a RULE-SET rule pointing outside the library', () => {
    expect(() => ensureValidRuleSetRef({ type: 'RULE-SET', value: 'ghost' }, names)).toThrow(/不存在/);
  });

  it('rejects a RULE-SET rule with an empty value', () => {
    expect(() => ensureValidRuleSetRef({ type: 'RULE-SET', value: '' }, names)).toThrow();
  });
});
