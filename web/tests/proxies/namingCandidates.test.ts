import { describe, expect, it } from 'vitest';
import { analyzeNamingCandidate, groupNodeMembers, inferNamingTemplates, rankNamingCandidates,
  type CandidateGroup, type CandidateNode, type CandidateProfile } from '@/lib/proxies/namingCandidates';
import { applyRenameTemplate, withRawIdentity } from '@/lib/proxies/naming';

const node = (identity: string, name: string, scoped = true, type = 'ss'): CandidateNode => ({ identity, name, scoped, type, sourceKey: scoped ? 'airport' : 'other' });
const before = [node('hk', 'HK IEPL x2 01'), node('jp', 'JP IPLC 02'), node('other', 'HK IEPL existing', false)];
const after = [node('hk', '香港 家宽 01'), node('jp', '日本 家宽 02'), before[2]];
const group = (values: Record<string, unknown> = {}): CandidateGroup => ({ id: 'g', name: '线路', values: { 'include-all-proxies': true, filter: 'IEPL', ...values } });
const profile = (groups = [group()]): CandidateProfile => ({ id: 'p', name: 'Profile', groups, rules: [], before, after });
const template = { id: 'test', title: 'Test', template: '${region}' };

describe('policy-aware candidate inference and membership', () => {
  it('infers region, tags, rate, source and vendor from selectors and real nodes', () => {
    const nodes = [node('a', 'HK IEPL 2x Nexitally 01')];
    const inferred = inferNamingTemplates(nodes, [group({ filter: 'HK|🇭🇰|IEPL|x\\d|airport|Nexitally' })], true);
    expect(inferred).toHaveLength(3);
    expect(inferred[0].template).toContain('${region_code}');
    expect(inferred[0].template).toContain('${tags}');
    expect(inferred[0].template).toContain('${rate}');
    expect(inferred[0].template).toContain('${source}');
    expect(inferred[0].template).toContain('${vendor}');
    expect(inferred[1].template).toContain('${tags}');
    expect(new Set(inferred.map((c) => c.template)).size).toBe(inferred.length);
  });

  it('combines explicit members, dynamic filters, exclusions and Mihomo adapter types', () => {
    const nodes = [...before, node('vmess', 'HK IEPL vmess', true, 'vmess')];
    expect(groupNodeMembers(group({ proxies: ['JP IPLC 02', 'DIRECT'], 'exclude-filter': 'existing', 'exclude-type': 'Shadowsocks' }), nodes).nodes.map((n) => n.identity)).toEqual(['jp', 'vmess']);
    const bound = { ...group({ filter: 'HK', 'include-all-proxies': false }), boundSourceKeys: ['airport'] };
    expect(groupNodeMembers(bound, nodes).nodes.map((n) => n.identity)).toEqual(['hk', 'jp', 'vmess']);
    expect(groupNodeMembers(group({ filter: '[' }), nodes).error).toBeTruthy();
  });

  it('counts all groups across profiles while preserving other sources and proposes only exact-set recovery', () => {
    const result = analyzeNamingCandidate(template, [profile(), { ...profile([group({ filter: 'IPLC' })]), id: 'p2' }], after.map((n) => n.name));
    expect(result.groups.map((g) => [g.before, g.after])).toEqual([[2, 1], [1, 0]]);
    expect(result.groups[0].migration?.after).toBe(2);
    expect(result.groups[1].emptied).toBe(true);
    expect(result.emptiedGroups).toHaveLength(1);
    const recovered = groupNodeMembers(group(), after, result.groups[0].migration!.filter);
    expect(recovered.nodes.map((n) => n.identity)).toEqual(['hk', 'other']);
    expect(result.sample).toEqual(after.map((n) => n.name));
    expect(result.blocked).toBe(false);
  });

  it('does not propose recovery when nodes vanished, exclusions prevent recovery, or providers are unknown', () => {
    const dropped = { ...profile(), after: after.filter((n) => n.identity !== 'hk') };
    expect(analyzeNamingCandidate(template, [dropped], []).groups[0].migration).toBeUndefined();
    expect(analyzeNamingCandidate(template, [profile([group({ 'exclude-filter': '家宽' })])], []).groups[0].migration).toBeUndefined();
    const providers = analyzeNamingCandidate(template, [profile([group({ 'include-all': true })])], []);
    expect(providers.groups[0].migration).toBeUndefined();
    expect(providers.warnings[0]).toContain('provider');
  });

  it('does not confuse equal counts with recovered identities or propose migration for gains alone', () => {
    const swapped = { ...profile(), after: [node('hk', '香港 家宽'), node('jp', '日本 IEPL'), before[2]] };
    const result = analyzeNamingCandidate(template, [swapped], []);
    expect(result.groups[0].before).toBe(result.groups[0].after);
    expect(result.groups[0].migration).toBeDefined();
    const gain = { ...profile(), after: [node('hk', '香港 IEPL'), node('jp', '日本 IEPL'), before[2]] };
    expect(analyzeNamingCandidate(template, [gain], []).groups[0].migration).toBeUndefined();
  });

  it('reports manual, rule and dialer rewrites by identity and blocks ambiguous or read-only references', () => {
    const input = profile([group({ proxies: [before[0].name], 'dialer-proxy': before[0].name })]);
    input.rules.push({ id: 'rule', policy: before[0].name });
    let result = analyzeNamingCandidate(template, [input], []);
    expect(result.references.map((r) => r.kind)).toEqual(['manual', 'dialer', 'rule']);
    expect(result.references.every((r) => r.after === after[0].name && !r.blocked)).toBe(true);
    result = analyzeNamingCandidate(template, [{ ...input, after: [...after, node('hk', 'duplicate identity')] }], []);
    expect(result.blocked).toBe(true);
    expect(result.references.every((r) => r.blocked)).toBe(true);
    const native = { ...input, before: [...before, { ...node('front', 'front', false), dialer: before[0].name }],
      after: [...after, { ...node('front', 'front', false), dialer: after[0].name }] };
    expect(analyzeNamingCandidate(template, [native], []).references.at(-1)?.blocked).toBe(false);
    native.after.at(-1)!.dialer = before[0].name;
    expect(analyzeNamingCandidate(template, [native], []).blocked).toBe(true);
  });

  it('ranks count changes, then empties, then broken exact references deterministically', () => {
    const changed = analyzeNamingCandidate({ ...template, id: 'changed' }, [profile()], []);
    const stable = analyzeNamingCandidate({ ...template, id: 'stable' }, [{ ...profile(), after: before }], []);
    const refs = { ...stable, id: 'refs', references: changed.references.concat({ profileId: 'p', kind: 'rule' as const, owner: 'r', before: 'old', after: 'new', blocked: false }) };
    expect(rankNamingCandidates([changed, refs, stable]).map((c) => c.id)).toEqual(['stable', 'refs', 'changed']);
  });

  it('supports profiles without groups, empty pools, bounded samples and deterministic results', () => {
    expect(inferNamingTemplates([], [], false)).toHaveLength(3);
    const result = analyzeNamingCandidate(template, [{ ...profile([]), before: [], after: [] }], Array.from({ length: 25 }, (_, i) => `node ${i}`));
    expect(result.groups).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.sample).toHaveLength(20);
    expect(result).toEqual(analyzeNamingCandidate(template, [{ ...profile([]), before: [], after: [] }], Array.from({ length: 25 }, (_, i) => `node ${i}`)));
  });

  it('rewrites native dialers within a naming stage by identity and remains idempotent', () => {
    const nodes = [
      withRawIdentity({ name: 'HK old 01', type: 'ss', server: 'hk.example', port: 443 }, { key: 'airport', label: 'airport' }),
      withRawIdentity({ name: 'JP front 02', type: 'ss', server: 'jp.example', port: 443, 'dialer-proxy': 'HK old 01' }, { key: 'airport', label: 'airport' }),
    ];
    const config = { template: '${region}' };
    const rendered = applyRenameTemplate(nodes, config).proxies;
    expect(rendered.map((n) => n.name)).toEqual(['香港', '日本']);
    expect(rendered[1]['dialer-proxy']).toBe('香港');
    expect(applyRenameTemplate(rendered, config).proxies).toEqual(rendered);
  });
});
