import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseBase } from '@/lib/engine/parser';
import { renderBase } from '@/lib/engine/renderer';
import { validateBase } from '@/lib/engine/validator';
import type { Rule } from '@/schemas';

const FIXTURE = readFileSync(resolve(__dirname, '../fixtures/sample-base.yaml'), 'utf8');

function makeRule(overrides: Partial<Rule>): Rule {
  return {
    id: 'test-id',
    anchor: 'manual',
    type: 'DOMAIN-SUFFIX',
    value: 'example.com',
    policy: '香港',
    rank: 100,
    source: 'manual',
    added_at: 1716000000,
    updated_at: 1716000000,
    ...overrides,
  };
}

describe('parse → validate → render pipeline', () => {
  it('produces valid YAML that re-parses with rules properly merged', () => {
    const parsed = parseBase(FIXTURE);

    const rules: Rule[] = [
      makeRule({ id: '1', anchor: 'manual', value: 'emby.media', policy: '香港', rank: 10 }),
      makeRule({ id: '2', anchor: 'manual', value: 'openai.com', policy: '日本', rank: 20 }),
      makeRule({ id: '3', anchor: 'prelude', value: 'override.com', policy: '直连', rank: 1 }),
    ];

    const validation = validateBase(parsed, rules);
    expect(validation.valid).toBe(true);

    const rendered = renderBase(FIXTURE, rules);

    // The rendered output must still parse as valid YAML
    const reparsed = parseYaml(rendered.content) as { rules: string[] };
    expect(Array.isArray(reparsed.rules)).toBe(true);

    // The injected rules must appear in the final rules array
    expect(reparsed.rules).toContain('DOMAIN-SUFFIX,emby.media,香港');
    expect(reparsed.rules).toContain('DOMAIN-SUFFIX,openai.com,日本');
    expect(reparsed.rules).toContain('DOMAIN-SUFFIX,override.com,直连');

    // Original baseline rules should still be present and in order
    const idxOriginal = reparsed.rules.indexOf('GEOIP,lan,直连');
    const idxOverride = reparsed.rules.indexOf('DOMAIN-SUFFIX,override.com,直连');
    const idxManual = reparsed.rules.indexOf('DOMAIN-SUFFIX,emby.media,香港');
    const idxMatch = reparsed.rules.indexOf('MATCH,默认');
    expect(idxOriginal).toBeGreaterThanOrEqual(0);
    expect(idxOverride).toBeGreaterThan(idxOriginal);
    expect(idxManual).toBeGreaterThan(idxOverride);
    expect(idxMatch).toBeGreaterThan(idxManual);
  });

  it('blocks save when a rule would become orphaned', () => {
    const parsed = parseBase(FIXTURE);
    const rules: Rule[] = [makeRule({ anchor: 'never-existed' })];
    const validation = validateBase(parsed, rules);
    expect(validation.valid).toBe(false);
    expect(validation.orphans[0].reason).toContain('anchor');
  });
});
