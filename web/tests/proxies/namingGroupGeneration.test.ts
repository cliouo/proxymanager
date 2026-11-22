import { describe, expect, it } from 'vitest';
import { defaultTemplateFor, formatNodeName } from '@/lib/proxies/naming';
import { GROUPING_PURPOSES, generateNamingGroups, groupingCounts, templateForGrouping } from '@/lib/proxies/namingGroupGeneration';
import { groupNodeMembers, type CandidateNode } from '@/lib/proxies/namingCandidates';

const template = templateForGrouping(defaultTemplateFor(true), GROUPING_PURPOSES);
const raw = ['HK IEPL 0.5x 01', 'JP 家宽 02', 'HK BGP 03'];
const nodes: CandidateNode[] = raw.map((name, i) => ({ identity: `node-${i}`, name: formatNodeName({ name, index: i + 1,
  source: { key: i === 1 ? 'b' : 'a', label: i === 1 ? 'Backup' : 'Acme' }, config: { template } }),
  type: 'ss', scoped: true, sourceKey: i === 1 ? 'b' : 'a', sourceLabel: i === 1 ? 'Backup' : 'Acme', sourceId: i === 1 ? 'b' : 'a' }));
const members = (filter: string, pool = nodes) => groupNodeMembers({ id: 'g', name: 'g', values: { 'include-all-proxies': true, filter } }, pool).nodes;

describe('purpose-based naming and group generation', () => {
  it('retains required fields and generates every present region including singletons and the top selector', () => {
    const derived = templateForGrouping('${region_code} ${index}', GROUPING_PURPOSES);
    expect(derived).toContain('${rate}');
    expect(derived).toContain('${source}');
    expect(derived).toContain('${tags}');
    expect(derived).toBe(templateForGrouping('${region_code} ${index}', [...GROUPING_PURPOSES].reverse()));
    const result = generateNamingGroups(nodes, template, [...GROUPING_PURPOSES]);
    expect(result.warnings).toEqual([]);
    expect(result.blocked).toBe(false);
    expect(result.groups.map((g) => g.name)).toEqual(['节点选择', '🇭🇰 香港', '🇯🇵 日本', 'Acme', 'Backup', '低倍率', '专线', '家宽']);
    expect(result.groups[0].proxies).toEqual([...result.groups.slice(1).map((g) => g.name), 'DIRECT']);
    expect(result.groups.find((g) => g.name === '🇯🇵 日本')?.count).toBe(1);
    for (const group of result.groups.slice(1)) {
      expect(group.kind).toBe('filter');
      expect(group['include-all-proxies']).toBe(true);
      expect(members(group.filter!)).toHaveLength(group.count);
      expect(group.sample.length).toBeLessThanOrEqual(3);
      expect(group.filter).not.toContain('01');
    }
  });

  it('counts purposes from actual names, not duplicate profile views, including zero purposes', () => {
    expect(groupingCounts([...nodes, ...nodes]).map((p) => [p.id, p.count])).toEqual([
      ['region', 3], ['source', 3], ['low-rate', 1], ['dedicated', 1], ['residential', 1],
    ]);
    expect(groupingCounts([]).every((p) => p.count === 0)).toBe(true);
    expect(generateNamingGroups([], template, ['region'])).toMatchObject({ groups: [], blocked: true });
    expect(generateNamingGroups(nodes, template, [])).toMatchObject({ groups: [], blocked: true });
    const unknown = { ...nodes[0], identity: 'unknown', name: 'unrecognized' };
    const regionOnly = generateNamingGroups([...nodes, unknown], template, ['region']);
    expect(regionOnly.groups[0].count).toBe(3);
    expect(regionOnly.groups[0].sample).not.toContain('unrecognized');
  });

  it('keeps identical fingerprints in distinct sources separate during selector validation', () => {
    const sharedIdentity = nodes.map((n) => ({ ...n, identity: 'same-fingerprint' }));
    const result = generateNamingGroups(sharedIdentity, template, ['source']);
    expect(result.blocked).toBe(false);
    expect(result.groups.slice(1).every((g) => g.kind === 'filter')).toBe(true);
  });

  it('suffixes node, builtin and existing group collisions deterministically', () => {
    const withCollision = [...nodes, { ...nodes[0], identity: 'collision', name: '节点选择', sourceKey: 'c', sourceId: 'c', sourceLabel: 'DIRECT' }];
    const result = generateNamingGroups(withCollision, template, ['region', 'source'], ['🇭🇰 香港', 'Acme']);
    expect(result.groups[0].name).toBe('节点选择 (2)');
    expect(result.groups.some((g) => g.name === '🇭🇰 香港 (2)')).toBe(true);
    expect(new Set(result.groups.map((g) => g.name)).size).toBe(result.groups.length);
    expect(result.groups.some((g) => g.name === 'DIRECT (2)')).toBe(true);
    expect(result).toEqual(generateNamingGroups(withCollision, template, ['region', 'source'], ['🇭🇰 香港', 'Acme']));
  });

  it('captures fresh region, dedicated, home and lower-rate values without admitting other fields', () => {
    const result = generateNamingGroups(nodes, template, [...GROUPING_PURPOSES]);
    const fresh = ['HK BGP 2x 90', 'JP IPLC 0.25x 91', 'JP 家宽 92'].map((name, i) => ({ ...nodes[0], identity: `fresh-${i}`,
      name: formatNodeName({ name, index: 90 + i, source: { key: 'a', label: 'Acme' }, config: { template } }) }));
    const low = result.groups.find((g) => g.name === '低倍率')!;
    expect(members(low.filter!, fresh).map((n) => n.identity)).toEqual(['fresh-1']);
    const dedicated = result.groups.find((g) => g.name === '专线')!;
    expect(members(dedicated.filter!, fresh).map((n) => n.identity)).toEqual(['fresh-1']);
    const home = result.groups.find((g) => g.name === '家宽')!;
    expect(members(home.filter!, fresh).map((n) => n.identity)).toEqual(['fresh-2']);
  });

  it('fails closed when a required field is absent and uses source binding only when a selector cannot validate', () => {
    const noTags = [{ ...nodes[0], name: '香港 IEPL 01', namingTemplate: '${region} ${index}' }];
    expect(generateNamingGroups(noTags, '${region} ${index}', ['dedicated'])).toMatchObject({ blocked: true, groups: [] });
    const noSource = nodes.map((n) => ({ ...n, name: n.name.replace(/ · (Acme|Backup)/g, ''), namingTemplate: '${region} ${index}' }));
    const bound = generateNamingGroups(noSource, '${region} ${index}', ['source']);
    expect(bound.blocked).toBe(false);
    expect(bound.groups.slice(1).every((g) => g.kind === 'single-sub' && !g.filter && !!g.bound_subscription_id)).toBe(true);
    expect(generateNamingGroups(noSource.map((n) => ({ ...n, sourceId: undefined })), '${region}', ['source']).blocked).toBe(true);
  });
});
