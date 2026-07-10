import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BaseParseError, parseBase } from '@/lib/engine/parser';

const FIXTURE = readFileSync(resolve(__dirname, '../fixtures/sample-base.yaml'), 'utf8');

describe('parseBase', () => {
  it('extracts anchors in order of appearance', () => {
    const result = parseBase(FIXTURE);
    expect(result.anchors).toEqual(['prelude', 'manual', 'late']);
  });

  it('P3-11: only reports anchors whose comment occupies its own line (renderer-injectable)', () => {
    const content = [
      'rules:',
      '  # === ANCHOR: good ===', // own line → injectable, reported
      '  - DOMAIN,x.com,直连  # === ANCHOR: inline === ', // trailing on a rule line → renderer won't inject here
      'dns:',
      '  note: "text === ANCHOR: invalue === more"', // buried in a value → not an anchor
    ].join('\n');
    const result = parseBase(content);
    expect(result.anchors).toEqual(['good']);
    expect(result.anchors).not.toContain('inline');
    expect(result.anchors).not.toContain('invalue');
  });

  it('extracts proxy-groups, standalone proxies, and built-in keywords as policies', () => {
    const result = parseBase(FIXTURE);
    expect(result.policies).toEqual([
      '默认',
      '香港',
      '日本',
      '美国',
      '直连',
      'DIRECT',
      'REJECT',
      'REJECT-DROP',
      'PASS',
      'COMPATIBLE',
    ]);
  });

  it('keeps built-in policies in an empty document', () => {
    const result = parseBase('mixed-port: 7890\n');
    expect(result.policies).toEqual(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);
  });

  it('extracts proxy-providers keys', () => {
    const result = parseBase(FIXTURE);
    expect(result.proxyProviders).toEqual(['airport-a', 'airport-b']);
  });

  it('extracts rule-providers keys', () => {
    const result = parseBase(FIXTURE);
    expect(result.ruleProviders).toEqual(['cn_domain', 'emby_classic']);
  });

  it('returns empty arrays for an empty document (except built-in policies)', () => {
    const result = parseBase('mixed-port: 7890\n');
    expect(result.anchors).toEqual([]);
    expect(result.proxyProviders).toEqual([]);
    expect(result.ruleProviders).toEqual([]);
  });

  it('deduplicates anchors with the same name', () => {
    const yaml = `rules:
  # === ANCHOR: foo ===
  - GEOIP,lan,直连
  # === ANCHOR: foo ===
`;
    const result = parseBase(yaml);
    expect(result.anchors).toEqual(['foo']);
  });

  it('tolerates extra whitespace inside anchor markers', () => {
    const yaml = `rules:
  #   ===  ANCHOR:   alpha   ===
  - MATCH,默认
`;
    const result = parseBase(yaml);
    expect(result.anchors).toEqual(['alpha']);
  });

  it('throws BaseParseError on invalid YAML', () => {
    expect(() => parseBase('proxy-groups:\n  - {{ broken')).toThrow(BaseParseError);
  });
});
