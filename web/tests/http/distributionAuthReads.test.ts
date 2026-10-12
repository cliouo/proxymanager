import { beforeEach, expect, it, vi } from 'vitest';
import { ProblemDetailsError } from '@/lib/http/problem';
const mocks = vi.hoisted(() => ({
  guardSubToken: vi.fn(),
  getRuleSet: vi.fn(),
  getSubscription: vi.fn(),
  listRuleSets: vi.fn(),
  listSubscriptionSummaries: vi.fn(),
}));
vi.mock('@/lib/repos/distributionIdentityRepo', () => ({
  findDistributionIdentity: async (kind: string) => ({
    id: kind === 'subscription' ? 'sub-id' : 'rules-id',
  }),
}));
vi.mock('@/lib/http/subGuard', () => ({ guardSubToken: mocks.guardSubToken }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({
  listRuleSets: mocks.listRuleSets,
  getRuleSet: mocks.getRuleSet,
}));
vi.mock('@/lib/services/ruleSetService', () => ({ getRuleSetByName: mocks.getRuleSet }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  listSubscriptionSummaries: mocks.listSubscriptionSummaries,
  getSubscription: mocks.getSubscription,
}));
vi.mock('@/lib/services/subscriptionService', () => ({
  getSubscriptionByName: mocks.getSubscription,
}));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: async () => 1 }));
vi.mock('@/lib/services/nodeExportService', () => ({ exportSubscriptionNodes: vi.fn() }));
import { GET as ruleSet } from '@/app/api/rule-providers/[token]/[name]/route';
import { GET as source } from '@/app/api/sub/[token]/source/[name]/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guardSubToken.mockRejectedValue(ProblemDetailsError.unauthorized('Invalid token'));
  mocks.listRuleSets.mockResolvedValue([{ id: 'rules-id', name: 'large', source: 'local' }]);
  mocks.listSubscriptionSummaries.mockResolvedValue([
    { id: 'sub-id', name: 'large', kind: 'local', enabled: true },
  ]);
  mocks.getRuleSet.mockResolvedValue({ id: 'rules-id', name: 'large', content: 'large body' });
  mocks.getSubscription.mockResolvedValue({
    id: 'sub-id',
    name: 'large',
    content: 'large body',
    enabled: true,
  });
});
it.each([
  ['rules', ruleSet],
  ['source', source],
] as const)('does not fetch %s body for an invalid token', async (_kind, handler) => {
  const response = await handler(new Request('https://pm.test/api/public'), {
    params: Promise.resolve({ token: 'invalid', name: 'large' }),
  });
  expect(response.status).toBe(401);
  expect(mocks.getRuleSet).not.toHaveBeenCalled();
  expect(mocks.getSubscription).not.toHaveBeenCalled();
});
it('fetches an authorized rule set by the authenticated ID, never by a reassigned name', async () => {
  mocks.guardSubToken.mockResolvedValue(undefined);
  const response = await ruleSet(new Request('https://pm.test/api/public'), {
    params: Promise.resolve({ token: 'valid', name: 'large' }),
  });
  expect(response.status).toBe(200);
  expect(mocks.getRuleSet).toHaveBeenCalledWith('rules-id');
});
