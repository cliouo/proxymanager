import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, Rule, Subscription } from '@/schemas';

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  resolveSubscriptionProxies: vi.fn(),
  getBase: vi.fn(),
  getConfigVersion: vi.fn(),
  getProfile: vi.fn(),
  listCollections: vi.fn(),
  listProxyGroups: vi.fn(),
  listProxyGroupTemplates: vi.fn(),
  listRules: vi.fn(),
  listRuleSets: vi.fn(),
  listSubscriptions: vi.fn(),
}));

vi.mock('@/lib/engine/resolve', () => ({ resolveConfig: mocks.resolveConfig }));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxies: mocks.resolveSubscriptionProxies,
}));
vi.mock('@/lib/repos/baseRepo', () => ({ getBase: mocks.getBase }));
vi.mock('@/lib/repos/configVersionRepo', () => ({
  getConfigVersion: mocks.getConfigVersion,
}));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: mocks.getProfile }));
vi.mock('@/lib/repos/collectionsRepo', () => ({
  listCollections: mocks.listCollections,
}));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({
  listProxyGroups: mocks.listProxyGroups,
}));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({
  listProxyGroupTemplates: mocks.listProxyGroupTemplates,
}));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: mocks.listRuleSets }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  listSubscriptions: mocks.listSubscriptions,
}));

import { ConfigPreflightUnavailableError, ConfigValidationError } from '@/lib/config/errors';
import { applyConfigEntityChanges, preflightProfileConfig } from '@/lib/services/configPreflight';
import {
  SubscriptionResolutionValidationError,
  SubscriptionUpstreamUnavailableError,
} from '@/lib/services/subscriptionResolutionErrors';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE = {
  id: PROFILE_ID,
  name: 'default',
  source: { type: 'none' },
  updated_at: 1,
} as Profile;
const REMOTE_SUB = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'remote-source',
  enabled: true,
  kind: 'remote',
  url: 'https://example.invalid/sub',
  ttl_ms: 60_000,
  tags: [],
  operators: [],
} as Subscription;
const RULE = {
  id: '33333333-3333-4333-8333-333333333333',
  anchor: 'manual',
  type: 'MATCH',
  value: '',
  policy: 'DIRECT',
  rank: 10,
  source: 'manual',
  added_at: 1,
  updated_at: 1,
} as Rule;

describe('preflightProfileConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigVersion.mockResolvedValue(7);
    mocks.getProfile.mockResolvedValue(PROFILE);
    mocks.getBase.mockResolvedValue({
      content: 'proxies: []\nrules: []\n',
      etag: 'base-etag',
      anchors: [],
      policies: [],
      updated_at: 1,
    });
    mocks.listRules.mockResolvedValue([]);
    mocks.listSubscriptions.mockResolvedValue([REMOTE_SUB]);
    mocks.listProxyGroups.mockResolvedValue([]);
    mocks.listProxyGroupTemplates.mockResolvedValue([]);
    mocks.listRuleSets.mockResolvedValue([]);
    mocks.listCollections.mockResolvedValue([]);
    mocks.resolveConfig.mockResolvedValue({ content: 'ok' });
    mocks.resolveSubscriptionProxies.mockResolvedValue({ proxies: [], proxyCount: 0 });
  });

  it('renders the in-memory candidate without snapshot or fetch-cache writes', async () => {
    mocks.resolveConfig.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[5] as {
        persistSnapshot?: boolean;
        snapshotProfileId?: string;
        subscriptionResolver: (sub: Subscription) => Promise<unknown>;
      };
      expect(options.persistSnapshot).toBe(false);
      expect(options.snapshotProfileId).toBeUndefined();
      await options.subscriptionResolver(REMOTE_SUB);
      return { content: 'ok' };
    });

    const checked = await preflightProfileConfig(PROFILE_ID, () => ({ rules: [RULE] }));

    expect(checked.configVersion).toBe(7);
    expect(checked.candidate.rules).toEqual([RULE]);
    expect(mocks.resolveConfig).toHaveBeenCalledWith(
      'proxies: []\nrules: []\n',
      [RULE],
      [REMOTE_SUB],
      [],
      [],
      expect.objectContaining({
        ignoreFailedSubs: false,
        persistSnapshot: false,
        boundSource: PROFILE.source,
      }),
    );
    expect(mocks.resolveSubscriptionProxies).toHaveBeenCalledWith(REMOTE_SUB, {
      writeCache: false,
      allowStale: false,
    });
  });

  it('classifies a remote-source failure as temporarily unavailable without echoing it', async () => {
    mocks.resolveSubscriptionProxies.mockRejectedValueOnce(
      new SubscriptionUpstreamUnavailableError('Upstream fetch failed'),
    );
    mocks.resolveConfig.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[5] as {
        subscriptionResolver: (sub: Subscription) => Promise<unknown>;
      };
      await options.subscriptionResolver(REMOTE_SUB);
      return { content: 'unreachable' };
    });

    const error = await preflightProfileConfig(PROFILE_ID, () => ({})).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConfigPreflightUnavailableError);
    expect((error as Error).message).toBe('Configuration validation is temporarily unavailable.');
  });

  it('reports a remote operator failure as a safe deterministic validation error', async () => {
    const secret = 'DO_NOT_REFLECT_OPERATOR_OR_NODE_SECRET';
    mocks.resolveSubscriptionProxies.mockRejectedValueOnce(
      new SubscriptionResolutionValidationError('operators', 'subscription_operators_invalid', {
        type: 'https://proxymanager.dev/errors/bad-request',
        title: 'Bad Request',
        status: 400,
        detail: secret,
      }),
    );
    mocks.resolveConfig.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[5] as {
        subscriptionResolver: (sub: Subscription) => Promise<unknown>;
      };
      await options.subscriptionResolver(REMOTE_SUB);
      return { content: 'unreachable' };
    });

    const error = await preflightProfileConfig(PROFILE_ID, () => ({})).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).issue).toEqual({
      code: 'subscription_operators_invalid',
      message: 'A subscription operator pipeline is invalid.',
      section: 'subscriptions',
      path: 'subscriptions[].operators',
      resource: 'subscription',
    });
    expect((error as Error).message).not.toContain(secret);
  });

  it('preserves deterministic validation errors', async () => {
    const expected = new ConfigValidationError({
      code: 'proxy_group_member_missing',
      message: 'A proxy-group member is missing.',
      section: 'proxy-groups',
      path: 'proxy-groups[0].proxies',
      resource: 'rendered-config',
    });
    mocks.resolveConfig.mockRejectedValueOnce(expected);

    await expect(preflightProfileConfig(PROFILE_ID, () => ({}))).rejects.toBe(expected);
  });

  it('does not misclassify an unknown validator failure as user input', async () => {
    const expected = new Error('programming failure');
    mocks.resolveConfig.mockRejectedValueOnce(expected);

    await expect(preflightProfileConfig(PROFILE_ID, () => ({}))).rejects.toBe(expected);
  });

  it('does not misclassify an unknown repository failure as validation unavailable', async () => {
    const expected = new Error('repository programming failure');
    mocks.getBase.mockRejectedValueOnce(expected);

    await expect(preflightProfileConfig(PROFILE_ID, () => ({}))).rejects.toBe(expected);
  });

  it('retries a mixed storage snapshot before building the candidate', async () => {
    mocks.getConfigVersion
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5);

    const checked = await preflightProfileConfig(PROFILE_ID, () => ({}));

    expect(checked.configVersion).toBe(5);
    expect(mocks.getBase).toHaveBeenCalledTimes(2);
    expect(mocks.resolveConfig).toHaveBeenCalledTimes(1);
  });
});

describe('applyConfigEntityChanges', () => {
  it('matches the commit order when the same id is both written and deleted', () => {
    expect(
      applyConfigEntityChanges(
        [{ id: 'same', value: 'old' }],
        [{ id: 'same', value: 'new' }],
        ['same'],
      ),
    ).toEqual([]);
  });
});
