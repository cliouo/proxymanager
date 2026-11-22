import { describe, expect, it } from 'vitest';
import { collectionMemberExecution, collectionMemberNamingWarnings, hasPostTemplateRenameRows } from '@/lib/proxies/collectionNaming';
import { applyRenameTemplate, nodeFingerprint, withRawIdentity, type NodeRecognitionFacts, type RecognitionRule } from '@/lib/proxies/naming';
import { mergeEnvelope } from '@/lib/proxies/provenance';
import type { StoredOperator } from '@/schemas/operator';

const template: StoredOperator = {
  id: 'naming', kind: 'rename-template', template: '${region} ${index}', recognitionRules: [],
};
const rename: StoredOperator = { id: 'rename', kind: 'rename-regex', pattern: 'old', replacement: 'new' };

describe('managed collection member execution', () => {
  it('removes only the active member template without changing stored rows', () => {
    const rows = [rename, template, { id: 'filter', kind: 'filter-useless' as const, extra: [] }];
    const snapshot = structuredClone(rows);
    expect(collectionMemberExecution(rows).operators).toEqual([rows[0], rows[2]]);
    expect(rows).toEqual(snapshot);
    expect(collectionMemberExecution([]).operators).toEqual([]);
    expect(collectionMemberNamingWarnings([{ id: 'empty', operators: [] }], true)).toEqual([]);
  });

  it.each<StoredOperator>([rename, { id: 'flag', kind: 'flag-emoji', action: 'add' }])('keeps a template followed by $kind and warns only for managed collections', (row) => {
    const rows = [template, row];
    expect(hasPostTemplateRenameRows(rows)).toBe(true);
    expect(collectionMemberExecution(rows).operators).toEqual(rows);
    expect(collectionMemberNamingWarnings([{ id: 'member-id', operators: rows }], true)).toEqual([
      { code: 'member-post-template-rename', memberId: 'member-id', message: 'post-template rename rows; convert to facts/rules' },
    ]);
    expect(collectionMemberNamingWarnings([{ id: 'member-id', operators: rows }], false)).toEqual([]);
  });

  it('ignores disabled templates and disabled post-template edits', () => {
    expect(hasPostTemplateRenameRows([{ ...template, disabled: true }, rename])).toBe(false);
    expect(hasPostTemplateRenameRows([template, { ...rename, disabled: true }])).toBe(false);
    expect(hasPostTemplateRenameRows([rename, template])).toBe(false);
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
});
