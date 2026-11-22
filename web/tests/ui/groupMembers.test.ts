import { describe, expect, it } from 'vitest';
import { autoMembers, manualMembersEmptyHint } from '@/ui/features/groups/model';

describe('manual member empty state', () => {
  it('counts dynamic matches after exclusions instead of claiming the group is empty', () => {
    const auto = autoMembers(['HK 01', 'HK 02', 'JP 01'], 'HK', '02', [], null);
    expect(manualMembersEmptyHint(true, auto.matched.length)).toBe('手动成员为空；已有 1 个节点来自筛选。');
  });

  it('only claims there are no members when dynamic membership is disabled', () => {
    expect(manualMembersEmptyHint(false, 2)).toContain('还没有成员');
    expect(manualMembersEmptyHint(true, 0)).toBe('手动成员为空；当前筛选没有匹配节点。');
  });

  it('does not misreport a loading or invalid selector as an empty group', () => {
    expect(autoMembers(['HK 01'], '[', '', [], null).error).toBeTruthy();
    expect(manualMembersEmptyHint(true, null)).toBe('手动成员为空；动态成员正在加载或暂不可用。');
  });
});
