import { describe, expect, it } from 'vitest';
import type { NamingCandidate } from '@/lib/proxies/namingCandidates';
import { candidateRationale } from '@/ui/features/naming/model';

const candidate: NamingCandidate = {
  id: 'compact', title: 'Compact', template: '${region_code}', sample: [],
  groups: [{ profileId: 'p', profileName: 'P', groupId: 'g', groupName: 'G', before: 3, after: 3, emptied: false }],
  emptiedGroups: [], references: [], warnings: [], blocked: false,
};

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
