import { describe, expect, it } from 'vitest';
import { validateBase } from '@/lib/engine/validator';
import type { ParsedBase } from '@/lib/engine/parser';
import type { Rule } from '@/schemas';

const PARSED: ParsedBase = {
  anchors: ['prelude', 'manual', 'late'],
  policies: ['默认', '香港', '日本', '直连'],
  proxyProviders: [],
  ruleProviders: [],
};

function makeRule(overrides: Partial<Rule>): Rule {
  return {
    id: 'test-id',
    anchor: 'manual',
    type: 'DOMAIN',
    value: 'example.com',
    policy: '香港',
    rank: 100,
    source: 'manual',
    added_at: 1716000000,
    updated_at: 1716000000,
    ...overrides,
  };
}

describe('validateBase', () => {
  it('returns valid=true when no rules', () => {
    const result = validateBase(PARSED, []);
    expect(result.valid).toBe(true);
    expect(result.orphans).toEqual([]);
  });

  it('returns valid=true when all rules reference existing anchors and policies', () => {
    const result = validateBase(PARSED, [
      makeRule({ id: 'a', anchor: 'manual', policy: '香港' }),
      makeRule({ id: 'b', anchor: 'late', policy: '默认' }),
    ]);
    expect(result.valid).toBe(true);
    expect(result.orphans).toEqual([]);
  });

  it('flags missing anchor', () => {
    const result = validateBase(PARSED, [makeRule({ id: 'r', anchor: 'gone', policy: '香港' })]);
    expect(result.valid).toBe(false);
    expect(result.orphans).toEqual([
      { rule_id: 'r', reason: 'anchor "gone" not present in base.yaml' },
    ]);
  });

  it('flags missing policy', () => {
    const result = validateBase(PARSED, [makeRule({ id: 'r', anchor: 'manual', policy: '美国' })]);
    expect(result.valid).toBe(false);
    expect(result.orphans).toEqual([
      { rule_id: 'r', reason: 'policy "美国" not present in proxy-groups' },
    ]);
  });

  it('reports both reasons when a rule has missing anchor AND missing policy', () => {
    const result = validateBase(PARSED, [makeRule({ id: 'r', anchor: 'gone', policy: '美国' })]);
    expect(result.valid).toBe(false);
    expect(result.orphans).toHaveLength(2);
    expect(result.orphans.map((o) => o.reason)).toEqual([
      'anchor "gone" not present in base.yaml',
      'policy "美国" not present in proxy-groups',
    ]);
  });

  it('echoes parsed anchors and policies in the result for UI consumption', () => {
    const result = validateBase(PARSED, []);
    expect(result.anchors).toEqual(PARSED.anchors);
    expect(result.policies).toEqual(PARSED.policies);
  });

  it('ignores RULE-SET references when no provider set is supplied', () => {
    const result = validateBase(PARSED, [
      makeRule({ id: 'r', type: 'RULE-SET', value: 'whatever', policy: '香港' }),
    ]);
    expect(result.valid).toBe(true);
  });

  it('flags a RULE-SET rule pointing outside the provider library', () => {
    const result = validateBase(
      PARSED,
      [makeRule({ id: 'r', type: 'RULE-SET', value: 'ghost', policy: '香港' })],
      new Set(['cn_domain']),
    );
    expect(result.valid).toBe(false);
    expect(result.orphans).toEqual([
      { rule_id: 'r', reason: 'RULE-SET 引用的规则集 "ghost" 不在规则集库中' },
    ]);
  });

  it('accepts a RULE-SET rule whose provider is in the library', () => {
    const result = validateBase(
      PARSED,
      [makeRule({ id: 'r', type: 'RULE-SET', value: 'cn_domain', policy: '香港' })],
      new Set(['cn_domain']),
    );
    expect(result.valid).toBe(true);
  });
});
