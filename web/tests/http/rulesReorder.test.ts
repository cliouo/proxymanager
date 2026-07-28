import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@/schemas';

const mocks = vi.hoisted(() => ({
  resolveScopeProfile: vi.fn(),
  getConfigVersion: vi.fn(),
  listRules: vi.fn(),
  preflightAndCommitProfileChanges: vi.fn(),
}));

vi.mock('@/lib/profileScope', () => ({ resolveScopeProfile: mocks.resolveScopeProfile }));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: mocks.getConfigVersion }));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/services/profileConfigMutationService', () => ({
  preflightAndCommitProfileChanges: mocks.preflightAndCommitProfileChanges,
}));

import { POST } from '@/app/api/v1/rules/reorder/route';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: crypto.randomUUID(),
    anchor: 'late',
    type: 'DOMAIN',
    value: 'example.com',
    policy: 'DIRECT',
    rank: 10,
    source: 'manual',
    added_at: 1,
    updated_at: 1,
    ...overrides,
  } as Rule;
}

describe('POST /api/v1/rules/reorder terminal MATCH', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveScopeProfile.mockResolvedValue({ id: PROFILE_ID, name: 'default' });
    mocks.getConfigVersion.mockResolvedValue(7);
    mocks.preflightAndCommitProfileChanges.mockResolvedValue({});
  });

  it('normalizes an active MATCH after ordinary rules while ignoring a parked MATCH', async () => {
    const activeMatch = rule({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'MATCH',
      value: '',
      rank: 10,
    });
    const domain = rule({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      rank: 20,
    });
    const parkedMatch = rule({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'MATCH',
      value: '',
      rank: 30,
      enabled: false,
    });
    mocks.listRules.mockResolvedValue([activeMatch, domain, parkedMatch]);

    const response = await POST(
      new Request('https://pm.test/api/v1/rules/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor: 'late', step: 10 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.preflightAndCommitProfileChanges).toHaveBeenCalledWith(
      PROFILE_ID,
      {
        ruleWrites: expect.arrayContaining([
          expect.objectContaining({ id: domain.id, rank: 10 }),
          expect.objectContaining({ id: parkedMatch.id, rank: 20, enabled: false }),
          expect.objectContaining({ id: activeMatch.id, rank: 30, type: 'MATCH' }),
        ]),
      },
      7,
    );
  });
});
