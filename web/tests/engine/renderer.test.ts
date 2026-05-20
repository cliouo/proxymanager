import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBase, renderRule } from '@/lib/engine/renderer';
import type { Rule } from '@/schemas';

const FIXTURE = readFileSync(resolve(__dirname, '../fixtures/sample-base.yaml'), 'utf8');

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

describe('renderRule', () => {
  it('formats DOMAIN-SUFFIX as type,value,policy', () => {
    expect(
      renderRule(makeRule({ type: 'DOMAIN-SUFFIX', value: 'emby.media', policy: '香港' })),
    ).toBe('DOMAIN-SUFFIX,emby.media,香港');
  });

  it('formats MATCH without value field', () => {
    expect(renderRule(makeRule({ type: 'MATCH', value: '', policy: '默认' }))).toBe('MATCH,默认');
  });

  it('formats RULE-SET correctly', () => {
    expect(renderRule(makeRule({ type: 'RULE-SET', value: 'cn_ip', policy: '直连' }))).toBe(
      'RULE-SET,cn_ip,直连',
    );
  });
});

describe('renderBase', () => {
  it('injects rules at the matching anchor, sorted by rank', () => {
    const rules: Rule[] = [
      makeRule({ id: 'b', anchor: 'manual', value: 'b.com', rank: 20 }),
      makeRule({ id: 'a', anchor: 'manual', value: 'a.com', rank: 10 }),
      makeRule({ id: 'c', anchor: 'manual', value: 'c.com', rank: 30 }),
    ];
    const result = renderBase(FIXTURE, rules);
    const lines = result.content.split('\n');
    const idx = lines.findIndex((l) => l.includes('=== ANCHOR: manual ==='));
    expect(lines[idx + 1].trim()).toBe('- DOMAIN,a.com,香港');
    expect(lines[idx + 2].trim()).toBe('- DOMAIN,b.com,香港');
    expect(lines[idx + 3].trim()).toBe('- DOMAIN,c.com,香港');
  });

  it('preserves anchor marker line and original indentation', () => {
    const rules: Rule[] = [makeRule({ value: 'preserve.com' })];
    const result = renderBase(FIXTURE, rules);
    expect(result.content).toContain('  # === ANCHOR: manual ===');
    expect(result.content).toContain('  - DOMAIN,preserve.com,香港');
  });

  it('leaves anchor markers untouched when there are no rules for them', () => {
    const result = renderBase(FIXTURE, []);
    expect(result.content).toContain('# === ANCHOR: prelude ===');
    expect(result.content).toContain('# === ANCHOR: manual ===');
    expect(result.content).toContain('# === ANCHOR: late ===');
    expect(result.anchorsApplied.every((s) => s.ruleCount === 0)).toBe(true);
  });

  it('reports rules whose anchor is not present in base as unmatched', () => {
    const rules: Rule[] = [makeRule({ anchor: 'nonexistent' })];
    const result = renderBase(FIXTURE, rules);
    expect(result.unmatchedAnchors).toEqual(['nonexistent']);
  });

  it('produces a stable 8-char buildId', () => {
    const rules: Rule[] = [makeRule({})];
    const a = renderBase(FIXTURE, rules);
    const b = renderBase(FIXTURE, rules);
    expect(a.buildId).toEqual(b.buildId);
    expect(a.buildId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces a different buildId when rules change', () => {
    const a = renderBase(FIXTURE, [makeRule({ value: 'a.com' })]);
    const b = renderBase(FIXTURE, [makeRule({ value: 'b.com' })]);
    expect(a.buildId).not.toEqual(b.buildId);
  });

  it('aggregates rule counts per anchor', () => {
    const rules: Rule[] = [
      makeRule({ id: '1', anchor: 'manual', value: 'a.com' }),
      makeRule({ id: '2', anchor: 'manual', value: 'b.com' }),
      makeRule({ id: '3', anchor: 'late', value: 'c.com' }),
    ];
    const result = renderBase(FIXTURE, rules);
    const map = Object.fromEntries(result.anchorsApplied.map((s) => [s.anchor, s.ruleCount]));
    expect(map).toEqual({ prelude: 0, manual: 2, late: 1 });
  });
});
