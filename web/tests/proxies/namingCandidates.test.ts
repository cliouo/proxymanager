import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { materializeDynamicProxyGroups } from '@/lib/engine/materializeProxyGroups';
import { analyzeNamingCandidate, groupNodeMembers, inferNamingTemplates, rankNamingCandidates,
  type CandidateGroup, type CandidateNode, type CandidateProfile } from '@/lib/proxies/namingCandidates';
import { applyRenameTemplate, formatNodeName, withRawIdentity } from '@/lib/proxies/naming';

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
    expect(inferred.every((item) => item.template.includes('${rate:include1x}'))).toBe(true);
    expect(inferred[0].template).toContain('${source}');
    expect(inferred[0].template).toContain('${vendor}');
    expect(inferred[1].template).toContain('${tags}');
    expect(new Set(inferred.map((c) => c.template)).size).toBe(inferred.length);
  });

  it('combines explicit members, dynamic filters, exclusions and Mihomo adapter types', () => {
    const nodes = [...before, node('vmess', 'HK IEPL vmess', true, 'vmess')];
    expect(groupNodeMembers(group({ proxies: ['JP IPLC 02', 'DIRECT'], 'exclude-filter': 'existing', 'exclude-type': 'Shadowsocks' }), nodes).nodes.map((n) => n.identity)).toEqual(['vmess']);
    const bound = { ...group({ filter: 'HK', 'include-all-proxies': false }), boundSourceKeys: ['airport'] };
    expect(groupNodeMembers(bound, nodes).nodes.map((n) => n.identity)).toEqual(['hk', 'jp', 'vmess']);
    expect(groupNodeMembers(group({ filter: '[' }), nodes).error).toBeTruthy();
  });

  it('counts all groups across profiles while preserving other sources and proposes only exact-set recovery', () => {
    const result = analyzeNamingCandidate(template, [profile([group({ filter: 'HK' })]), { ...profile([group({ filter: 'JP' })]), id: 'p2' }], after.map((n) => n.name));
    expect(result.groups.map((g) => [g.before, g.after])).toEqual([[2, 1], [1, 0]]);
    expect(result.groups[0].migration?.after).toBe(2);
    expect(result.groups[1].emptied).toBe(false);
    expect(result.emptiedGroups).toHaveLength(0);
    const recovered = groupNodeMembers(group({ filter: 'HK' }), after, result.groups[0].migration!.filter);
    expect(recovered.nodes.map((n) => n.identity)).toEqual(['hk', 'other']);
    expect(result.sample).toEqual(after.map((n) => n.name));
    expect(result.blocked).toBe(false);
  });

  it.each(['explicit', 'subscription', 'collection'])('excludes filtered names and types from %s members like materialization', (kind) => {
    const nodes = [node('http', 'HK HTTP', true, 'http'), node('excluded', 'JP IPLC', true, 'socks5'),
      node('keep', 'HK SOCKS', true, 'socks5'), node('other', 'Other HTTP', false, 'http')];
    const boundSourceKeys = kind === 'explicit' ? undefined : kind === 'subscription' ? ['airport'] : ['airport', 'other'];
    const proxies = nodes.filter((n) => !boundSourceKeys || boundSourceKeys.includes(n.sourceKey!)).map((n) => n.name);
    const input = { ...group({ proxies, filter: '^no-match$', 'exclude-filter': 'IPLC', 'exclude-type': 'http' }), boundSourceKeys };
    const members = groupNodeMembers(input, nodes);
    expect(members.nodes.map((n) => n.identity)).toEqual(['keep']);
    expect(members.error).toBeNull();
    const rendered = parse(materializeDynamicProxyGroups(stringify({
      proxies: nodes.map((n) => ({ name: n.name, type: n.type, server: `${n.identity}.example`, port: 8080 })),
      'proxy-groups': [{ ...input.values, name: 'Members', type: 'select', proxies }],
    })));
    expect(members.nodes.map((n) => n.name)).toEqual(rendered['proxy-groups'][0].proxies);
  });

  it('uses the fallback only after all explicit and dynamic members are excluded', () => {
    const fallback = group({ filter: '^no-match$', 'empty-fallback': before[0].name, 'exclude-type': 'shadowsocks' });
    expect(groupNodeMembers(fallback, before).nodes).toEqual([before[0]]);
    expect(groupNodeMembers({ ...fallback, values: { ...fallback.values, proxies: ['DIRECT'] } }, before).nodes).toEqual([]);
    expect(groupNodeMembers({ ...fallback, values: { ...fallback.values, proxies: ['DIRECT'], 'exclude-filter': 'DIRECT' } }, before).nodes).toEqual([before[0]]);
    expect(groupNodeMembers(fallback, []).nodes).toEqual([]);
    expect(groupNodeMembers(group({ proxies: [before[0].name], filter: '', 'exclude-filter': '[' }), before).error).toBeTruthy();
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
    expect(result.groups[0].migration).toBeUndefined();
    expect(result.groups[0].broken).toBe(true);
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

  it('rewrites parked rules when unique but never blocks on their missing or ambiguous mappings', () => {
    const input = { ...profile([]), rules: [{ id: 'parked', policy: before[0].name, enabled: false }] };
    const unique = analyzeNamingCandidate(template, [input], []);
    expect(unique.references).toEqual([
      { profileId: 'p', kind: 'rule', owner: 'parked', before: before[0].name, after: after[0].name, blocked: false },
    ]);
    for (const pool of [after.slice(1), [...after, node('hk', 'ambiguous')]]) {
      const parked = analyzeNamingCandidate(template, [{ ...input, after: pool }], []);
      expect(parked.references).toEqual([]);
      expect(parked.blocked).toBe(false);
      expect(parked.warnings).toEqual([]);
      expect(analyzeNamingCandidate(template, [{ ...input, after: pool, rules: [{ ...input.rules[0], enabled: true }] }], []).blocked).toBe(true);
      expect(analyzeNamingCandidate(template, [{ ...input, after: pool, rules: [{ id: 'legacy', policy: before[0].name }] }], []).blocked).toBe(true);
    }
  });

  it('tracks fallback references and blocks missing or ambiguous targets', () => {
    const input = profile([group({ 'empty-fallback': before[0].name })]);
    expect(analyzeNamingCandidate(template, [input], []).references).toEqual([
      { profileId: 'p', kind: 'fallback', owner: 'g', before: before[0].name, after: after[0].name, blocked: false },
    ]);
    const missing = analyzeNamingCandidate(template, [{ ...input, after: after.slice(1) }], []);
    expect(missing.references[0]).toMatchObject({ kind: 'fallback', blocked: true, after: undefined });
    expect(missing.blocked).toBe(true);
    expect(analyzeNamingCandidate(template, [{ ...input, after: [...after, node('hk', 'ambiguous')] }], []).blocked).toBe(true);
    expect(analyzeNamingCandidate(template, [{ ...input, after: before }], []).references).toEqual([]);
  });

  it('never migrates an unrelated selector to recover a renamed fallback-only member', () => {
    const input = profile([group({ filter: '^Singapore$', 'empty-fallback': before[1].name })]);
    expect(groupNodeMembers(input.groups[0], before).nodes).toEqual([before[1]]);
    const result = analyzeNamingCandidate(template, [input], []);
    expect(result.groups[0]).toMatchObject({ before: 1, after: 0 });
    expect(result.groups[0].migration).toBeUndefined();
    expect(result.references).toContainEqual({ profileId: 'p', kind: 'fallback', owner: 'g',
      before: before[1].name, after: after[1].name, blocked: false });
    const rewritten = { ...input.groups[0], values: { ...input.groups[0].values, 'empty-fallback': after[1].name } };
    expect(groupNodeMembers(rewritten, after).nodes).toEqual([after[1]]);
    expect(groupNodeMembers(rewritten, [...after, node('sg', 'Singapore')]).nodes.map((n) => n.identity)).toEqual(['sg']);
  });

  it('still migrates lost selector matches when the group also has a fallback', () => {
    const input = profile([group({ filter: 'HK', 'empty-fallback': before[1].name })]);
    const result = analyzeNamingCandidate(template, [input], []);
    expect(result.groups[0].migration?.after).toBe(2);
    expect(result.groups[0].migration?.filter).not.toContain('01');
  });

  it('retains rate selectors across refreshed nodes and never enumerates final names', () => {
    const original = [node('us', '🇺🇸 Chicago 01 ×0.5'), node('sg', '🇸🇬 SG 02 BGP ×0.5'), node('tw', '🇹🇼 TW 06 ×0.5'), node('jp', '🇯🇵 Tokyo 04 倍率2')];
    const input = group({ filter: '×0\\.5' });
    const render = (n: CandidateNode, naming: string) => ({ ...n, name: formatNodeName({ name: n.name, index: 1, config: { template: naming } }) });
    const templates = inferNamingTemplates(original, [input], true);
    for (const item of templates) {
      expect(item.template).toContain('${rate:include1x}');
      const renamed = original.map((n) => render(n, item.template));
      const result = analyzeNamingCandidate(item, [{ ...profile([input]), before: original, after: renamed }], []);
      const migration = result.groups[0].migration!;
      expect(migration.after).toBe(3);
      expect(migration.filter).not.toMatch(/01|02|06|Chicago|SG 02/);
      const fresh = render(node('new-us', '🇺🇸 Chicago 09 | 0.5x'), item.template);
      expect(groupNodeMembers(input, [...renamed, fresh], migration.filter).nodes).toHaveLength(4);
      expect(groupNodeMembers(input, [...renamed, render(node('high', '🇺🇸 Chicago 10 | 10.5x'), item.template)], migration.filter).nodes).toHaveLength(3);
    }
    const dropped = '${region_code} ${index}${?tags: · ${tags}}';
    const broken = analyzeNamingCandidate({ ...template, template: dropped }, [{ ...profile([input]), before: original, after: original.map((n) => render(n, dropped)) }], []);
    expect(broken.groups[0]).toMatchObject({ broken: true });
    expect(broken.emptiedGroups).toHaveLength(1);
    expect(broken.groups[0].migration).toBeUndefined();
  });

  it('ranks unchanged selectors ahead of recovered groups, and recovery ahead of broken selectors', () => {
    const migrated = analyzeNamingCandidate(template, [profile([group({ filter: 'HK' })])], []);
    const stable = { ...migrated, id: 'stable', groups: migrated.groups.map((g) => ({ ...g, after: g.before, migration: undefined })) };
    const broken = { ...migrated, id: 'broken', groups: migrated.groups.map((g) => ({ ...g, migration: undefined, broken: true })) };
    expect(rankNamingCandidates([broken, migrated, stable]).map((c) => c.id)).toEqual(['stable', 'test', 'broken']);
  });

  it.each([
    ['家庭宽带', 'HK 家庭宽带 01', 'HK 家宽 01', '${region_code} ${tags} ${index}', undefined, '家宽'],
    ['^Acme', 'Acme HK 01', 'HK 01 · Acme', '${region_code} ${index} · ${source}', 'Acme', 'Acme'],
  ])('migrates %s through rendered fields rather than ordinals', (filter, original, renamed, naming, sourceLabel, token) => {
    const before = [{ ...node('hk', original), sourceLabel }];
    const after = [{ ...before[0], name: renamed }];
    const input = group({ filter });
    const candidate = analyzeNamingCandidate({ ...template, template: naming }, [{ ...profile([input]), before, after }], []);
    expect(candidate.groups[0].migration?.filter).toContain(token);
    expect(candidate.groups[0].migration?.filter).not.toContain('01');
    expect(candidate.groups[0].migration?.after).toBe(1);
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
