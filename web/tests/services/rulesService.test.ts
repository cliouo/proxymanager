import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@/schemas';

const mocks = vi.hoisted(() => ({
  listRules: vi.fn(),
}));

vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));

import { computeNextRank } from '@/lib/services/rulesService';

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

describe('computeNextRank terminal MATCH', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts ordinary late appends before an active starter MATCH', async () => {
    mocks.listRules.mockResolvedValue([
      rule({ type: 'MATCH', value: '', policy: 'DIRECT', rank: 100 }),
    ]);

    await expect(computeNextRank(PROFILE_ID, 'late')).resolves.toBe(10);
  });

  it('does not treat a disabled MATCH as terminal', async () => {
    mocks.listRules.mockResolvedValue([
      rule({ type: 'MATCH', value: '', rank: 100, enabled: false }),
    ]);

    await expect(computeNextRank(PROFILE_ID, 'late')).resolves.toBe(110);
  });
});
