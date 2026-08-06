import { beforeAll, describe, expect, it } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { analyzeSourceFacts } from '@/lib/proxies/namingHealth';
import { withSource } from '@/lib/proxies/provenance';
import { projectNodeSnapshot } from '@/lib/ai/namingContextProjection';

const node = (name: string, type = 'vless', server = 'edge.invalid') => ({
  name,
  type,
  server,
  port: 443,
});

beforeAll(() => {
  installTestHandleSecret();
});

describe('analyzeSourceFacts', () => {
  it('reports exact coverage counts and percentages per placeholder', () => {
    const proxies = [
      withSource(node('🇭🇰 香港 01'), { key: 'a', label: '机场A' }),
      withSource(node('🇭🇰 香港 02'), { key: 'a', label: '机场A' }),
      withSource(node('日本 2x'), { key: 'a', label: '机场A' }),
    ];
    const [report] = analyzeSourceFacts(proxies);
    expect(report.sourceKey).toBe('a');
    expect(report.nodeCount).toBe(3);
    const byField = new Map(report.fields.map((f) => [f.field, f]));
    expect(byField.get('region')).toMatchObject({ present: 3, total: 3, percent: 100 });
    expect(byField.get('rate')).toMatchObject({ present: 1, total: 3, percent: 33 });
    expect(byField.get('source')).toMatchObject({ present: 3, total: 3, percent: 100 });
    expect(byField.get('index')).toMatchObject({ present: 3, total: 3, percent: 100 });
    // note: residuals are 01/02 — the index-like residual is the note here
    expect(byField.get('note')!.present).toBeGreaterThan(0);
  });

  it('distinguishes intrinsic (protocol), derived (region/rate), ai-rule, assigned VALUES', () => {
    const proxies = [withSource(node('香港 中转 01', 'trojan'), { key: 'a', label: '机场A' })];
    const rules = [{ pattern: '中转', field: 'route' as const, value: '中转' }];
    const [report] = analyzeSourceFacts(proxies, { rules });
    const byField = new Map(report.fields.map((f) => [f.field, f]));
    // per-value provenance + confidence
    expect(byField.get('protocol')!.samples[0]).toMatchObject({
      value: 'trojan',
      kind: 'intrinsic',
      confidence: 'high',
    });
    expect(byField.get('region')!.samples[0]).toMatchObject({
      kind: 'derived',
      confidence: 'medium',
    });
    expect(byField.get('route')!.samples[0]).toMatchObject({ kind: 'ai-rule' });
    expect(byField.get('source')!.samples[0]).toMatchObject({ kind: 'assigned' });
    expect(byField.get('region')!.confidence).toEqual({ high: 0, medium: 1, low: 0 });
    // per-node facts: internal node IDENTITY (raw name + fingerprint +
    // occurrence) + per-field confidence/provenance — external surfaces
    // project identities through the typed node scope
    const protocolFact = report.nodeFacts.find((f) => f.field === 'protocol');
    expect(protocolFact).toMatchObject({
      node: /^🇭🇰 香港 01\x00[0-9a-f]{32}\x000$/,
      value: 'trojan',
      confidence: 'high',
      kind: 'intrinsic',
      ambiguous: false,
    });
    const routeFact = report.nodeFacts.find((f) => f.field === 'route');
    expect(routeFact).toMatchObject({ kind: 'ai-rule', confidence: 'high' });
    // unknown values stay unknown: vendor absent, null value + kind
    const vendorFact = report.nodeFacts.find((f) => f.field === 'vendor');
    expect(vendorFact).toMatchObject({ value: null, confidence: null });
  });

  it('reports unavailable and partial fields', () => {
    // second node has NO residual (region only) → note is partially available
    const proxies = [
      withSource(node('香港 01'), { key: 'a', label: '机场A' }),
      withSource(node('香港'), { key: 'a', label: '机场A' }),
    ];
    const [report] = analyzeSourceFacts(proxies);
    expect(report.unavailable).toContain('rate');
    expect(report.unavailable).toContain('vendor');
    expect(report.partial).toContain('note');
  });

  it('detects ambiguous signals (flag vs keyword conflict, multiple routes)', () => {
    const proxies = [
      withSource(node('🇭🇰 日本 01'), { key: 'a', label: '机场A' }),
      withSource(node('香港 中转 直连'), { key: 'a', label: '机场A' }),
      withSource(node('香港 01'), { key: 'a', label: '机场A' }),
    ];
    const [report] = analyzeSourceFacts(proxies);
    expect(report.ambiguousCount).toBe(2);
  });

  it('mixed built-in + rule facts keep per-value provenance (rule must MATCH the node)', () => {
    // A rule targets 'route' but only matches ONE node; the OTHER node's
    // built-in 中转 must stay derived, never ai-rule.
    const proxies = [
      withSource(node('香港 中转 01'), { key: 'a', label: '机场A' }),
      withSource(node('机场A 香港 01'), { key: 'a', label: '机场A' }),
    ];
    const rules = [{ pattern: '机场A', field: 'route' as const, value: '机场A' }];
    const [report] = analyzeSourceFacts(proxies, { rules });
    const byField = new Map(report.fields.map((f) => [f.field, f]));
    // 中转 produced by BUILT-IN recognition → derived (the rule never matched)
    const builtIn = byField.get('route')!.samples.find((s) => s.value === '中转');
    expect(builtIn).toMatchObject({ kind: 'derived', confidence: 'medium' });
    // 机场A produced by the RULE → ai-rule
    const ruled = byField.get('route')!.samples.find((s) => s.value === '机场A');
    expect(ruled).toMatchObject({ kind: 'ai-rule', confidence: 'high' });
    // per-node facts carry the same distinction
    const nodeFacts = report.nodeFacts;
    const derivedFact = nodeFacts.find((f) => f.field === 'route' && f.value === '中转');
    const ruleFact = nodeFacts.find((f) => f.field === 'route' && f.value === '机场A');
    expect(derivedFact).toMatchObject({ kind: 'derived' });
    expect(ruleFact).toMatchObject({ kind: 'ai-rule', confidence: 'high' });
  });

  it('reports drifted patterns from residuals (bounded)', () => {
    const proxies = [
      withSource(node('香港 10000x'), { key: 'a', label: '机场A' }),
      withSource(node('香港 家宽'), { key: 'a', label: '机场A' }),
    ];
    const [report] = analyzeSourceFacts(proxies);
    const driftFields = report.drift.map((d) => d.field);
    expect(driftFields).toContain('rate');
    expect(driftFields).toContain('route');
    for (const d of report.drift) {
      expect(d.samples.length).toBeLessThanOrEqual(3);
      for (const sample of d.samples) expect(sample.length).toBeLessThanOrEqual(24);
    }
  });

  it('round-1: internal analysis values are sanitized; raw identity text is internal-only and never reaches external projections', () => {
    const proxies = [
      withSource(node('香港 https://evil.example/sub?token=abc123'), { key: 'a', label: '机场A' }),
    ];
    const [report] = analyzeSourceFacts(proxies);
    // internal ANALYSIS fields (samples, values, labels) are sanitized —
    // credentials never appear in the report's derived content
    for (const field of ['region', 'route', 'vendor', 'note']) {
      const facts = report.nodeFacts.filter((f) => f.field === field);
      for (const f of facts) {
        if (f.value !== null) {
          expect(f.value).not.toContain('evil.example');
          expect(f.value).not.toContain('token=abc123');
        }
      }
    }
    // the deterministic node IDENTITY (raw name + fingerprint + occurrence)
    // is INTERNAL analysis text — the external boundary (typed node scope +
    // projector) never serializes it: the projected snapshot is credential-free
    const projected = JSON.stringify(projectNodeSnapshot(proxies));
    expect(projected).not.toContain('evil.example');
    expect(projected).not.toContain('token=abc123');
    expect(projected).toContain('香港');
  });

  it('per-source matrix for collections: one report per member source', () => {
    const proxies = [
      withSource(node('香港 01'), { key: 'a', label: '机场A' }),
      withSource(node('日本 01'), { key: 'b', label: '机场B' }),
    ];
    const reports = analyzeSourceFacts(proxies);
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.sourceKey).sort()).toEqual(['a', 'b']);
    expect(reports[0].fields.find((f) => f.field === 'source')!.present).toBe(1);
  });

  it('treats envelope-less nodes as one anonymous source', () => {
    const [report] = analyzeSourceFacts([node('香港 01'), node('日本 01')]);
    expect(report.nodeCount).toBe(2);
    expect(report.sourceLabel).toBe('(未命名)');
  });

  it('pass-2 edge: 4 nodes → nodeFactsTotal describes FACT ROWS (44), truncated=false at the report level', () => {
    const proxies = [
      withSource(node('🇭🇰 香港 01'), { key: 'a', label: '机场A' }),
      withSource(node('🇯🇵 日本 02'), { key: 'a', label: '机场A' }),
      withSource(node('🇺🇸 美国 03'), { key: 'a', label: '机场A' }),
      withSource(node('🇸🇬 新加坡 04'), { key: 'a', label: '机场A' }),
    ];
    const [report] = analyzeSourceFacts(proxies);
    // 4 nodes × 11 fields = 44 FACT ROWS — the semantic unit is facts, not nodes
    expect(report.nodeFactsTotal).toBe(44);
    expect(report.nodeFacts).toHaveLength(44);
    expect(report.nodeFactsTruncated).toBe(false);
    // field samples: 3 distinct values for region → sampleTotal 3, and at the
    // report level (cap 3) nothing is truncated yet
    const byField = new Map(report.fields.map((f) => [f.field, f]));
    expect(byField.get('region')!.sampleTotal).toBe(4);
    expect(byField.get('region')!.samples.length).toBe(3);
    expect(byField.get('region')!.sampleTruncated).toBe(true);
  });

  it('pass-2 edge: exactly 3 distinct region values → sampleTotal 3, sampleTruncated false at the report level', () => {
    // four nodes but only THREE distinct regions (HK, JP, US) — the exact
    // pass-2 cap edge: sampleTotal stays 3, all three serialize, nothing is
    // truncated at the report level
    const proxies = [
      withSource(node('🇭🇰 香港 01'), { key: 'a', label: '机场A' }),
      withSource(node('🇭🇰 香港 02'), { key: 'a', label: '机场A' }),
      withSource(node('🇯🇵 日本 03'), { key: 'a', label: '机场A' }),
      withSource(node('🇺🇸 美国 04'), { key: 'a', label: '机场A' }),
    ];
    const [report] = analyzeSourceFacts(proxies);
    const byField = new Map(report.fields.map((f) => [f.field, f]));
    expect(byField.get('region')!.sampleTotal).toBe(3);
    expect(byField.get('region')!.samples.length).toBe(3);
    expect(byField.get('region')!.sampleTruncated).toBe(false);
  });
});
