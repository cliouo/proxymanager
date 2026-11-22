import { describe, expect, it } from 'vitest';
import type { NamingCandidate } from '@/lib/proxies/namingCandidates';
import { candidateRationale, groupingPreviewMatches, groupingSelection, namingUndoFeedback, toggleGroupingPurpose } from '@/ui/features/naming/model';
import type { GroupingPreview } from '@/lib/proxies/namingGroupGeneration';
import { fetchQuery, getQueryData } from '@/ui/data/query';

const candidate: NamingCandidate = {
  id: 'compact', title: 'Compact', template: '${region_code}', sample: [],
  groups: [{ profileId: 'p', profileName: 'P', groupId: 'g', groupName: 'G', before: 3, after: 3, emptied: false }],
  emptiedGroups: [], references: [], warnings: [], blocked: false,
};

describe('grouping preview selection', () => {
  const preview: GroupingPreview = { configVersion: 1, template: '${region}', purposes: [
    { id: 'region', label: '地区', count: 2, selected: true }, { id: 'source', label: '来源', count: 2, selected: false },
  ], profiles: [], warnings: [], blocked: false };

  it('keeps rapid toggles while the previous preview is retained', () => {
    const first = toggleGroupingPurpose(groupingSelection(null, preview), 'source', true);
    const latest = toggleGroupingPurpose(first, 'region', false);
    expect(latest).toEqual(['source']);
    expect(groupingPreviewMatches(preview, latest)).toBe(false);
    expect(groupingPreviewMatches({ ...preview, purposes: preview.purposes.map((p) => ({ ...p, selected: p.id === 'source' })) }, latest)).toBe(true);
    expect(toggleGroupingPurpose(latest, 'source', true)).toEqual(['source']);
    expect(toggleGroupingPurpose(latest, 'source', false)).toEqual([]);
    expect(groupingPreviewMatches(undefined, [])).toBe(false);
  });

  it('isolates out-of-order responses by selection key', async () => {
    let resolveOld!: (value: GroupingPreview) => void;
    const old = fetchQuery('naming-polish:grouping:region', () => new Promise<GroupingPreview>((resolve) => { resolveOld = resolve; }));
    const latest = { ...preview, template: '${source}', purposes: preview.purposes.map((p) => ({ ...p, selected: p.id === 'source' })) };
    await fetchQuery('naming-polish:grouping:source', async () => latest);
    resolveOld(preview);
    await old;
    expect(getQueryData('naming-polish:grouping:source')).toBe(latest);
    expect(groupingPreviewMatches(getQueryData('naming-polish:grouping:region'), ['source'])).toBe(false);
  });
});

describe('candidate recommendation rationale', () => {
  it('explains unchanged selectors and group counts', () => {
    expect(candidateRationale(candidate)).toBe('无需改写任何筛选，所有策略组匹配数不变');
  });

  it('explains recovered groups using final rather than unmigrated counts', () => {
    expect(candidateRationale({ ...candidate, groups: [{ ...candidate.groups[0], after: 0, migration: { filter: '0\\.5x', after: 3 } }] }))
      .toBe('1 个筛选将迁移，所有策略组匹配数不变');
  });

  it('reports changed membership even when counts stay equal', () => {
    expect(candidateRationale({ ...candidate, groups: [{ ...candidate.groups[0], broken: true }] }))
      .toBe('1 个策略组的成员或匹配数会变化，需核对');
  });

  it('covers no groups and blocked references', () => {
    expect(candidateRationale({ ...candidate, groups: [] })).toBe('没有策略组，无需迁移筛选');
    expect(candidateRationale({ ...candidate, references: [{ profileId: 'p', kind: 'manual', owner: 'g', before: 'old', blocked: true }] }))
      .toContain('1 处精确引用无法自动迁移');
  });
});

describe('generated-group Undo feedback', () => {
  it('warns that Undo removes the generated groups and names them', () => {
    expect(namingUndoFeedback(['节点选择', '🇯🇵 日本'])).toEqual({ label: '撤销并移除 2 个策略组',
      description: '撤销将移除本次生成的 2 个策略组：节点选择、🇯🇵 日本。' });
  });
  it('counts groups from multiple profiles while listing repeated names once', () => {
    expect(namingUndoFeedback(['节点选择', '节点选择']).description).toBe('撤销将移除本次生成的 2 个策略组：节点选择。');
  });
  it('does not claim to remove groups when none were created', () => {
    expect(namingUndoFeedback()).toEqual({ label: '撤销', description: undefined });
    expect(namingUndoFeedback([]).description).toBeUndefined();
  });
});
