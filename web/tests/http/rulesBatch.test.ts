import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@/schemas';

const mocks = vi.hoisted(() => ({
  resolveScopeProfile: vi.fn(),
  recordEvents: vi.fn(),
  getConfigVersion: vi.fn(),
  listRules: vi.fn(),
  loadParsedBase: vi.fn(),
  loadProviderNames: vi.fn(),
  preflightAndCommitProfileChanges: vi.fn(),
}));

vi.mock('@/lib/profileScope', () => ({ resolveScopeProfile: mocks.resolveScopeProfile }));
vi.mock('@/lib/repos/auditRepo', () => ({ recordEvents: mocks.recordEvents }));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: mocks.getConfigVersion }));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/services/profileConfigMutationService', () => ({
  preflightAndCommitProfileChanges: mocks.preflightAndCommitProfileChanges,
}));
vi.mock('@/lib/services/rulesService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/rulesService')>();
  return {
    ...actual,
    loadParsedBase: mocks.loadParsedBase,
    loadProviderNames: mocks.loadProviderNames,
  };
});

import { POST } from '@/app/api/v1/rules/batch/route';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const DOMAIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RULE_SET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: DOMAIN_ID,
    anchor: 'manual',
    type: 'DOMAIN-SUFFIX',
    value: 'example.com',
    policy: 'DIRECT',
    rank: 30,
    source: 'manual',
    added_at: 1,
    updated_at: 1,
    ...overrides,
  } as Rule;
}

describe('POST /api/v1/rules/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveScopeProfile.mockResolvedValue({ id: PROFILE_ID, name: 'default' });
    mocks.getConfigVersion.mockResolvedValue(7);
    mocks.loadParsedBase.mockResolvedValue({ anchors: ['manual'], policies: ['DIRECT'] });
    mocks.loadProviderNames.mockResolvedValue(new Set(['ebay_classic']));
    mocks.preflightAndCommitProfileChanges.mockResolvedValue({});
    mocks.recordEvents.mockResolvedValue(undefined);
  });

  it('swaps rank with an existing RULE-SET rule without falsely rejecting its provider', async () => {
    const domain = rule({ id: DOMAIN_ID, rank: 30 });
    const ruleSet = rule({
      id: RULE_SET_ID,
      type: 'RULE-SET',
      value: 'ebay_classic',
      policy: 'ebay-static',
      rank: 20,
    });
    mocks.listRules.mockResolvedValue([domain, ruleSet]);

    const response = await POST(
      new Request('https://pm.test/api/v1/rules/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ops: [
            { op: 'update', id: DOMAIN_ID, patch: { rank: 20 } },
            { op: 'update', id: RULE_SET_ID, patch: { rank: 30 } },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.loadProviderNames).not.toHaveBeenCalled();
    expect(mocks.preflightAndCommitProfileChanges).toHaveBeenCalledWith(
      PROFILE_ID,
      {
        ruleWrites: expect.arrayContaining([
          expect.objectContaining({ id: DOMAIN_ID, rank: 20 }),
          expect.objectContaining({ id: RULE_SET_ID, rank: 30, value: 'ebay_classic' }),
        ]),
        ruleDeletes: [],
      },
      7,
    );
  });

  it('still validates the provider when a RULE-SET value changes', async () => {
    mocks.listRules.mockResolvedValue([
      rule({ id: RULE_SET_ID, type: 'RULE-SET', value: 'ebay_classic', rank: 20 }),
    ]);

    const response = await POST(
      new Request('https://pm.test/api/v1/rules/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ops: [{ op: 'update', id: RULE_SET_ID, patch: { value: 'missing' } }],
        }),
      }),
    );
    const body = (await response.json()) as { results: Array<{ status: number }> };

    expect(response.status).toBe(207);
    expect(body.results).toEqual([expect.objectContaining({ status: 422 })]);
    expect(mocks.loadProviderNames).toHaveBeenCalledOnce();
    expect(mocks.preflightAndCommitProfileChanges).not.toHaveBeenCalled();
  });
});
