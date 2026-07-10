import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@/schemas';

/**
 * P0-1: renaming a rule-set must cascade to every referencing RULE-SET rule
 * (across all profiles, since rule-sets are a shared library), and must refuse
 * when the old name is baked into a profile's base body as a `rule-set:` key.
 *
 * We mock at the repo boundary so the service's cascade logic is exercised in
 * isolation. `referencedProviderNamesInText` (renderer) runs for real.
 */

const profiles = [
  { id: 'p1', name: 'default' },
  { id: 'p2', name: 'work' },
];

let rulesByProfile: Record<string, Rule[]>;
let basesByProfile: Record<string, { content: string } | null>;
let currentSet: { id: string; name: string; format: string; content: string; source?: string; url?: string };

const upsertRulesMock = vi.fn<(id: string, rules: Rule[]) => Promise<void>>();
const upsertRuleSetMock = vi.fn<(set: unknown) => Promise<void>>();

vi.mock('@/lib/repos/profilesRepo', () => ({
  listProfiles: async () => profiles,
}));
vi.mock('@/lib/repos/rulesRepo', () => ({
  listRules: async (id: string) => rulesByProfile[id] ?? [],
  upsertRules: (id: string, rules: Rule[]) => upsertRulesMock(id, rules),
}));
vi.mock('@/lib/repos/baseRepo', () => ({
  getBase: async (id: string) => basesByProfile[id] ?? null,
}));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({
  getRuleSet: async () => currentSet,
  getRuleSetByName: async () => null, // no name collision in these tests
  listRuleSets: async () => [],
  upsertRuleSet: (set: unknown) => upsertRuleSetMock(set),
  deleteRuleSet: async () => true,
}));

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
    // p1 had one referencing rule → it must be re-upserted with the new value.
    const p1Writes = upsertRulesMock.mock.calls.filter((c) => c[0] === 'p1');
    expect(p1Writes.length).toBe(1);
    const written = p1Writes[0][1] as Rule[];
    expect(written).toHaveLength(1);
    expect(written[0].value).toBe('ads-v2');
    // p2 referenced 'other', not 'ads' → no write for p2.
    expect(upsertRulesMock.mock.calls.some((c) => c[0] === 'p2')).toBe(false);
    // The set itself was renamed.
    expect(upsertRuleSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'ads-v2' }));
  });

  it('refuses the rename when a base body references the old name via rule-set:', async () => {
    basesByProfile.p2 = { content: 'dns:\n  nameserver-policy:\n    "rule-set:ads": [1.1.1.1]\n' };
    await expect(svc.patchRuleSet('rs1', { name: 'ads-v2' })).rejects.toMatchObject({
      problem: { status: 409 },
    });
    // Nothing renamed/cascaded when blocked.
    expect(upsertRuleSetMock).not.toHaveBeenCalled();
    expect(upsertRulesMock).not.toHaveBeenCalled();
  });

  it('a no-op rename (same name) does not scan or cascade', async () => {
    await svc.patchRuleSet('rs1', { name: 'ads', content: 'payload: [DOMAIN,a.com]' });
    expect(upsertRulesMock).not.toHaveBeenCalled();
  });
});
