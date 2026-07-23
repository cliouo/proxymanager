import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileConfigState } from '@/lib/services/configPreflight';
import type { ProxyGroup, Rule } from '@/schemas';

const mocks = vi.hoisted(() => ({
  preflightProfileConfig: vi.fn(),
  commitProfileConfigChanges: vi.fn(),
}));

vi.mock('@/lib/services/configPreflight', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/configPreflight')>(
    '@/lib/services/configPreflight',
  );
  return { ...actual, preflightProfileConfig: mocks.preflightProfileConfig };
});
vi.mock('@/lib/repos/profileConfigMutationRepo', () => ({
  commitProfileConfigChanges: mocks.commitProfileConfigChanges,
}));

import { ConfigValidationError } from '@/lib/config/errors';
import { ProblemDetailsError } from '@/lib/http/problem';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const RULE = {
  id: '22222222-2222-4222-8222-222222222222',
  anchor: 'manual',
  type: 'MATCH',
  value: '',
  policy: 'DIRECT',
  rank: 10,
  source: 'manual',
  added_at: 1,
  updated_at: 1,
} as Rule;
const CANDIDATE = {
  profile: {
    id: PROFILE_ID,
    name: 'default',
    source: { type: 'none' },
    kind: 'normal' as const,
    updated_at: 1,
  },
  baseContent: 'proxies: []\nrules: []\n',
  rules: [RULE],
  subscriptions: [],
  proxyGroups: [],
  templates: [],
  ruleSets: [],
  collections: [],
} as ProfileConfigState;

function statusOf(error: unknown): number | undefined {
  return error instanceof ProblemDetailsError ? error.problem.status : undefined;
}

describe('preflightAndCommitProfileChanges concurrency gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preflightProfileConfig.mockResolvedValue({
      configVersion: 10,
      candidate: CANDIDATE,
    });
    mocks.commitProfileConfigChanges.mockResolvedValue({
      ok: true,
      currentVersion: 11,
    });
  });

  it('does not call the repo when the in-memory candidate is invalid', async () => {
    mocks.preflightProfileConfig.mockRejectedValueOnce(
      new ConfigValidationError({
        code: 'final_config_invalid',
        message: 'Candidate is invalid.',
        section: 'config',
        path: '$',
        resource: 'rendered-config',
      }),
    );

    await expect(
      preflightAndCommitProfileChanges(PROFILE_ID, { ruleWrites: [RULE] }, 10),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(mocks.commitProfileConfigChanges).not.toHaveBeenCalled();
  });

  it('returns 412 before commit when planning state moved before preflight', async () => {
    mocks.preflightProfileConfig.mockResolvedValueOnce({
      configVersion: 11,
      candidate: CANDIDATE,
    });

    const error = await preflightAndCommitProfileChanges(
      PROFILE_ID,
      { ruleWrites: [RULE] },
      10,
    ).catch((caught) => caught);

    expect(statusOf(error)).toBe(412);
    expect(mocks.commitProfileConfigChanges).not.toHaveBeenCalled();
  });

  it('returns 412 when the generation moves between preflight and atomic commit', async () => {
    mocks.commitProfileConfigChanges.mockResolvedValueOnce({
      ok: false,
      currentVersion: 11,
    });

    const error = await preflightAndCommitProfileChanges(
      PROFILE_ID,
      { ruleWrites: [RULE] },
      10,
    ).catch((caught) => caught);

    expect(statusOf(error)).toBe(412);
    expect(mocks.commitProfileConfigChanges).toHaveBeenCalledWith(
      PROFILE_ID,
      { ruleWrites: [RULE] },
      10,
    );
  });

  it('preflights proxy groups in the same rank/name order as the persisted read path', async () => {
    const first = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'manual',
      name: 'first',
      type: 'select',
      rank: 10,
      proxies: ['DIRECT'],
      updated_at: 1,
    } as ProxyGroup;
    const moved = {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'manual',
      name: 'moved',
      type: 'select',
      rank: 20,
      proxies: ['DIRECT'],
      updated_at: 1,
    } as ProxyGroup;
    const movedToFront = { ...moved, rank: 0, updated_at: 2 };
    mocks.preflightProfileConfig.mockImplementationOnce(async (_profileId, buildCandidate) => {
      const current = { ...CANDIDATE, proxyGroups: [first, moved] };
      const patch = await buildCandidate(current);
      expect(patch.proxyGroups?.map((group: ProxyGroup) => group.name)).toEqual(['moved', 'first']);
      return { configVersion: 10, candidate: { ...current, ...patch } };
    });

    await preflightAndCommitProfileChanges(PROFILE_ID, { proxyGroupWrites: [movedToFront] }, 10);
  });
});
