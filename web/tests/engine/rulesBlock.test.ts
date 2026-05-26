import { describe, expect, it } from 'vitest';
import { rulesBlockViolations } from '@/lib/services/baseService';

describe('rulesBlockViolations', () => {
  it('accepts a markers-only rules: block', () => {
    const content = [
      'mode: rule',
      'rules:',
      '  # === ANCHOR: prelude ===',
      '  # === ANCHOR: manual ===',
      '  # === ANCHOR: late ===',
      'rule-providers:',
      '  foo: {}',
    ].join('\n');
    expect(rulesBlockViolations(content)).toEqual([]);
  });

  it('flags an active rule line in the block', () => {
    const content = ['rules:', '  # === ANCHOR: manual ===', '  - DOMAIN,example.com,香港', 'dns:'].join('\n');
    const v = rulesBlockViolations(content);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain('example.com');
  });

  it('ignores commented-out rule lines', () => {
    const content = ['rules:', '  # === ANCHOR: late ===', '  # - DOMAIN,old.com,直连'].join('\n');
    expect(rulesBlockViolations(content)).toEqual([]);
  });

  it('catches rule items at column 0 (seq aligned with key)', () => {
    const content = ['rules:', '- MATCH,默认', 'proxies:'].join('\n');
    const v = rulesBlockViolations(content);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain('MATCH,默认');
  });

  it('stops at the next top-level section', () => {
    const content = ['rules:', '  # === ANCHOR: manual ===', 'proxies:', '  - { name: x }'].join('\n');
    expect(rulesBlockViolations(content)).toEqual([]);
  });

  it('returns nothing when there is no rules: block', () => {
    expect(rulesBlockViolations('mode: rule\ndns:\n  enable: true')).toEqual([]);
  });
});
