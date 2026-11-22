import { describe, expect, it } from 'vitest';
import { collectionMemberExecution, collectionMemberNamingWarnings, hasPostTemplateNameDependentRows } from '@/lib/proxies/collectionNaming';
import { applyRenameTemplate, nodeFingerprint, withRawIdentity, type NodeRecognitionFacts, type RecognitionRule } from '@/lib/proxies/naming';
import { mergeEnvelope } from '@/lib/proxies/provenance';
import type { StoredOperator } from '@/schemas/operator';

const template: StoredOperator = {
  id: 'naming', kind: 'rename-template', template: '${region} ${index}', recognitionRules: [],
};
const rename: StoredOperator = { id: 'rename', kind: 'rename-regex', pattern: 'old', replacement: 'new' };

describe('managed collection member execution', () => {
  it('removes only the active member template without changing stored rows', () => {
    const rows = [rename, template, { id: 'filter', kind: 'filter-type' as const, mode: 'keep' as const, types: ['ss'] }];
    const snapshot = structuredClone(rows);
    expect(collectionMemberExecution(rows).operators).toEqual([rows[0], rows[2]]);
    expect(rows).toEqual(snapshot);
    expect(collectionMemberExecution([]).operators).toEqual([]);
    expect(collectionMemberNamingWarnings([{ id: 'empty', operators: [] }], true)).toEqual([]);
  });

  it.each<StoredOperator>([
    rename,
    { id: 'flag', kind: 'flag-emoji', action: 'add' },
    { id: 'filter', kind: 'filter-regex', mode: 'keep', pattern: '^member ' },
    { id: 'useless', kind: 'filter-useless', extra: [] },
    { id: 'region', kind: 'filter-region', mode: 'keep', regions: ['HK'] },
    { id: 'sort', kind: 'sort', by: 'name', order: 'asc' },
    { id: 'sort', kind: 'sort', by: 'region', order: 'asc' },
    { id: 'dedup', kind: 'dedup', by: 'name', action: 'drop' },
    { id: 'dedup', kind: 'dedup', by: 'server-port', action: 'rename' },
  ])('keeps a template followed by name-dependent $kind and warns only for managed collections', (row) => {
    const rows = [template, row];
    expect(hasPostTemplateNameDependentRows(rows)).toBe(true);
    expect(collectionMemberExecution(rows).operators).toEqual(rows);
    expect(collectionMemberNamingWarnings([{ id: 'member-id', operators: rows }], true)).toEqual([
      { code: 'member-post-template-rename', memberId: 'member-id', message: 'post-template name-dependent rows; convert to facts/rules' },
    ]);
    expect(collectionMemberNamingWarnings([{ id: 'member-id', operators: rows }], false)).toEqual([]);
  });

  it('ignores disabled templates and disabled post-template edits', () => {
    expect(hasPostTemplateNameDependentRows([{ ...template, disabled: true }, rename])).toBe(false);
    expect(hasPostTemplateNameDependentRows([template, { ...rename, disabled: true }])).toBe(false);
    expect(hasPostTemplateNameDependentRows([rename, template])).toBe(false);
  });

  it.each<StoredOperator>([
    { id: 'sort', kind: 'sort', by: 'server', order: 'asc' },
    { id: 'sort', kind: 'sort', by: 'type', order: 'asc' },
    { id: 'dedup', kind: 'dedup', by: 'server-port', action: 'drop' },
    { id: 'props', kind: 'set-prop', udp: true },
  ])('still skips before name-independent $kind', (row) => {
    expect(collectionMemberExecution([template, row]).operators).toEqual([row]);
  });
});

describe('member corrections scoped by node envelope', () => {
  const node = (name = '香港 01') => withRawIdentity(
    { name, type: 'ss', server: 'edge.example', port: 443 }, { key: 'airport', label: 'Airport' },
  );
  const rule = (value: string): RecognitionRule => ({ pattern: '香港', field: 'region', value });

  it.each([
    { memberFacts: undefined, collectionFacts: undefined, collectionRules: [], expected: 'JP' },
    { memberFacts: undefined, collectionFacts: undefined, collectionRules: [rule('SG')], expected: 'SG' },
    { memberFacts: { region: 'US' }, collectionFacts: undefined, collectionRules: [rule('SG')], expected: 'US' },
    { memberFacts: { region: 'US' }, collectionFacts: { region: 'GB' }, collectionRules: [rule('SG')], expected: 'GB' },
  ])('uses collection facts > member facts > collection rules > member rules ($expected)', ({ memberFacts, collectionFacts, collectionRules, expected }) => {
    const original = node();
    const corrected = mergeEnvelope(original, { memberNaming: {
      facts: memberFacts as NodeRecognitionFacts | undefined, recognitionRules: [rule('JP')],
    } });
    const result = applyRenameTemplate([corrected], {
      template: '${region_code}', recognitionRules: collectionRules,
      nodeFacts: collectionFacts ? { [nodeFingerprint(original)!]: collectionFacts } : undefined,
    });
    expect(result.proxies[0].name).toBe(expected);
    const other = withRawIdentity({ ...node(), port: 444 }, { key: 'other', label: 'Other' });
    expect(applyRenameTemplate([other], { template: '${region_code}' }).proxies[0].name).toBe('HK');
  });

  it('inherits source aliases, lets the collection override them, and is idempotent', () => {
    const original = mergeEnvelope(node(), { memberNaming: {
      facts: { tags: ['家宽'] }, sourceAlias: 'Member',
    } });
    const config = { template: '${region}${?tags: · ${tags}} · ${source} · ${index}' };
    const first = applyRenameTemplate([original], config);
    expect(first.proxies[0].name).toBe('香港 · 家宽 · Member · 01');
    expect(applyRenameTemplate(first.proxies, config).proxies[0].name).toBe(first.proxies[0].name);
    expect(applyRenameTemplate([original], { ...config, sourceAliases: { airport: 'Collection' } }).proxies[0].name).toBe('香港 · 家宽 · Collection · 01');
    expect(JSON.stringify(first.proxies)).not.toContain('memberNaming');
  });

  it('carries info corrections and lets collection info override the member', () => {
    const original = mergeEnvelope(node('剩余流量 88 GB'), { memberNaming: { facts: { info: false, region: 'JP' } } });
    expect(applyRenameTemplate([original], { template: '${region_code}' }).proxies[0].name).toBe('JP');
    expect(applyRenameTemplate([original], {
      template: '${region_code}', nodeFacts: { [nodeFingerprint(original)!]: { info: true } },
    }).proxies).toEqual([]);
    expect(applyRenameTemplate([], { template: '${region}' }).proxies).toEqual([]);
  });

  it('uses effective member aliases in collision suffixes, with collection precedence', () => {
    const first = node();
    const second = mergeEnvelope(withRawIdentity(
      { name: '香港 01', type: 'ss', server: 'other.example', port: 443 },
      { key: 'other', label: 'Original' },
    ), { memberNaming: { sourceAlias: 'Member' } });
    const config = { template: '${region}' };
    const result = applyRenameTemplate([first, second], config);
    expect(result.proxies.map((p) => p.name)).toEqual(['香港', '香港 · Member-01']);
    expect(applyRenameTemplate(result.proxies, config).proxies.map((p) => p.name)).toEqual(result.proxies.map((p) => p.name));
    const overridden = applyRenameTemplate([first, second], { ...config, sourceAliases: { other: 'Collection' } });
    expect(overridden.proxies.map((p) => p.name)).toEqual(['香港', '香港 · Collection-01']);
    expect(JSON.stringify(result.proxies)).not.toContain('memberNaming');
  });
});
