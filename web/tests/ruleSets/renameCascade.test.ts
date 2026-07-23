import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@/schemas';
import type { RuleSetCommit } from '@/lib/repos/ruleSetsRepo';

/**
 * P0-1: renaming a rule-set must cascade to every referencing RULE-SET rule
 * (across all profiles, since rule-sets are a shared library), and must refuse
 * when the old name is baked into a profile's base body as a `rule-set:` key.
 *
 * We mock at the repo boundary so the service's cascade logic is exercised in
 * isolation. `referencedProviderNamesInBaseYaml` (renderer) runs for real.
 */

const profiles = [
  { id: 'p1', name: 'default' },
  { id: 'p2', name: 'work' },
];

let rulesByProfile: Record<string, Rule[]>;
let basesByProfile: Record<string, { content: string } | null>;
let currentSet: {
  id: string;
  name: string;
  format: string;
  content: string;
  source?: string;
  url?: string;
};

const commitMock = vi.fn<(change: RuleSetCommit, version: number) => Promise<unknown>>();
/** 每份 profile 的 preflight 结果:抛出的那份代表「这次改动会破坏它」。 */
let preflightFailure: Record<string, Error | undefined> = {};
/** 版本括号**内**的稳定快照 —— 候选必须从它推导。 */
let bracketState: { ruleSets: unknown[]; rules: Rule[] };
/** 候选构造回调实际产出的东西，供断言。 */
let lastCandidate: { ruleSets?: unknown[]; rules?: Rule[] } | null = null;

const preflightMock = vi.fn(
  async (profileId: string, build?: (s: typeof bracketState) => Record<string, unknown>) => {
    const failure = preflightFailure[profileId];
    if (failure) throw failure;
    if (build) lastCandidate = build(bracketState) as typeof lastCandidate;
    return { configVersion: 7, candidate: {} };
  },
);

vi.mock('@/lib/repos/profilesRepo', () => ({
  listProfiles: async () => profiles,
}));
vi.mock('@/lib/repos/rulesRepo', () => ({
  listRules: async (id: string) => rulesByProfile[id] ?? [],
}));
vi.mock('@/lib/repos/baseRepo', () => ({
  getBase: async (id: string) => basesByProfile[id] ?? null,
}));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: async () => 7 }));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: (profileId: string, build: (s: never) => Record<string, unknown>) =>
    preflightMock(profileId, build as never),
}));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({
  getRuleSet: async () => currentSet,
  getRuleSetByName: async () => null, // no name collision in these tests
  listRuleSets: async () => [],
  commitRuleSetChange: (change: RuleSetCommit, version: number) => commitMock(change, version),
  deleteRuleSet: async () => true,
}));

/** commitRuleSetChange 收到的那次调用。 */
function lastCommit(): RuleSetCommit {
  return commitMock.mock.calls.at(-1)![0];
}
/** 某 profile 的级联写集。 */
function cascadeFor(profileId: string): Rule[] {
  return (
    ((lastCommit().ruleWrites ?? []).find((g) => g.profileId === profileId)?.rules as Rule[]) ?? []
  );
}

function rule(over: Partial<Rule>): Rule {
  return {
    id: crypto.randomUUID(),
    anchor: 'manual',
    type: 'DOMAIN',
    value: 'example.com',
    policy: '香港',
    rank: 10,
    source: 'manual',
    added_at: 0,
    updated_at: 0,
    ...over,
  } as Rule;
}

let svc: typeof import('@/lib/services/ruleSetService');

beforeEach(async () => {
  vi.clearAllMocks();
  commitMock.mockResolvedValue({ ok: true, currentVersion: 8 });
  preflightFailure = {};
  lastCandidate = null;
  bracketState = {
    ruleSets: [{ id: 'rs1', name: 'ads', format: 'yaml', content: '' }],
    rules: [],
  };
  currentSet = { id: 'rs1', name: 'ads', format: 'yaml', content: 'payload: []', source: 'local' };
  rulesByProfile = {
    p1: [
      rule({ type: 'RULE-SET', value: 'ads', policy: 'REJECT' }),
      rule({ type: 'DOMAIN', value: 'x.com' }), // unrelated
    ],
    p2: [rule({ type: 'RULE-SET', value: 'other', policy: 'REJECT' })], // references a different set
  };
  basesByProfile = { p1: { content: 'mixed-port: 7890\n' }, p2: { content: 'mixed-port: 7890\n' } };
  svc = await import('@/lib/services/ruleSetService');
});

describe('rule-set rename cascade (P0-1)', () => {
  it('rewrites RULE-SET rules that reference the old name, across all profiles', async () => {
    await svc.patchRuleSet('rs1', { name: 'ads-v2' });

    // p1 引用了 ads → 级联改写它那条规则。
    const p1 = cascadeFor('p1');
    expect(p1).toHaveLength(1);
    expect(p1[0].value).toBe('ads-v2');
    // p2 引用的是 other → 不该出现在写集里。
    expect(cascadeFor('p2')).toHaveLength(0);
    // 规则集本身改名了,且与级联在**同一次** CAS 提交里。
    expect(lastCommit().write).toMatchObject({ name: 'ads-v2' });
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('refuses the rename when a base body references the old name via rule-set:', async () => {
    basesByProfile.p2 = { content: 'dns:\n  nameserver-policy:\n    "rule-set:ads": [1.1.1.1]\n' };
    await expect(svc.patchRuleSet('rs1', { name: 'ads-v2' })).rejects.toMatchObject({
      problem: { status: 409 },
    });
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('a no-op rename (same name) does not cascade', async () => {
    await svc.patchRuleSet('rs1', { name: 'ads', content: 'payload: [DOMAIN,a.com]' });
    expect(lastCommit().ruleWrites ?? []).toHaveLength(0);
  });
});

/* ─── 共享资源写入闸口（本轮修复） ──────────────────────────────────── */

describe('rule-set writes go through the shared-resource gate', () => {
  it('preflights every referencing profile before committing', async () => {
    await svc.patchRuleSet('rs1', { behavior: 'ipcidr' });

    // 只有 p1 引用 ads;p2 引用别的集合，不该为它白跑一次完整渲染。
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe('p1');
    expect(commitMock).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it('422s and NAMES the profile when the change would break it', async () => {
    preflightFailure = { p1: new Error('Full config render rejected: rule-provider behavior') };

    await expect(svc.patchRuleSet('rs1', { behavior: 'ipcidr' })).rejects.toThrow(/default/);
    // 破坏性改动绝不落库。
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('skips preflight entirely when nobody references the set', async () => {
    rulesByProfile = { p1: [], p2: [] };

    await svc.patchRuleSet('rs1', { behavior: 'ipcidr' });

    expect(preflightMock).not.toHaveBeenCalled();
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('412s when the preflighted generation no longer holds at commit time', async () => {
    commitMock.mockResolvedValue({ ok: false, currentVersion: 99 });
    await expect(svc.patchRuleSet('rs1', { behavior: 'ipcidr' })).rejects.toMatchObject({
      problem: { status: 412 },
    });
  });

  it('deleting a set also goes through the gate', async () => {
    await svc.deleteRuleSetChecked('rs1');
    expect(lastCommit()).toMatchObject({ deleteId: 'rs1' });
  });

  it('builds the candidate from the BRACKETED snapshot, not a pre-read library', async () => {
    // 括号内的库里另有一条别人刚加的规则集 —— 候选必须包含它，否则我们校验的是
    // 一个并发写者已经不存在的旧世界。
    bracketState = {
      ruleSets: [
        { id: 'rs1', name: 'ads', format: 'yaml', content: '' },
        { id: 'rs9', name: 'added-by-someone-else', format: 'yaml', content: '' },
      ],
      rules: rulesByProfile.p1,
    };

    await svc.patchRuleSet('rs1', { behavior: 'ipcidr' });

    const names = (lastCandidate?.ruleSets as { name: string }[]).map((x) => x.name);
    expect(names).toContain('added-by-someone-else');
    expect(lastCandidate?.ruleSets).toHaveLength(2);
  });

  it('hands preflight the FULL cascaded rule list, not just the rewritten rules', async () => {
    bracketState = {
      ruleSets: [{ id: 'rs1', name: 'ads', format: 'yaml', content: '' }],
      rules: rulesByProfile.p1, // 一条 RULE-SET + 一条无关规则
    };

    await svc.patchRuleSet('rs1', { name: 'ads-v2' });

    // 完整列表:无关的那条也要在，否则校验的是个残缺文档。
    expect(lastCandidate?.rules).toHaveLength(2);
    expect(lastCandidate?.rules?.find((r) => r.type === 'RULE-SET')?.value).toBe('ads-v2');
  });

  it('restoring a snapshot (undo) goes through the gate too', async () => {
    await svc.restoreRuleSet(
      { ...currentSet, name: 'ads', updated_at: 1 } as never,
      { ...currentSet, name: 'ads' } as never,
    );
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(lastCommit().write).toMatchObject({ name: 'ads' });
  });
});
