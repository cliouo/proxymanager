import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, Rule } from '@/schemas';

const mocks = vi.hoisted(() => ({
  getBase: vi.fn(),
  getConfigVersion: vi.fn(),
  getProfile: vi.fn(),
  listCollections: vi.fn(),
  listProxyGroups: vi.fn(),
  listProxyGroupTemplates: vi.fn(),
  listRules: vi.fn(),
  listRuleSets: vi.fn(),
  listSubscriptions: vi.fn(),
  listDevices: vi.fn(),
}));

vi.mock('@/lib/repos/baseRepo', () => ({ getBase: mocks.getBase }));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: mocks.getConfigVersion }));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: mocks.getProfile }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: mocks.listCollections }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({ listProxyGroups: mocks.listProxyGroups }));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({
  listProxyGroupTemplates: mocks.listProxyGroupTemplates,
}));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: mocks.listRuleSets }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({ listSubscriptions: mocks.listSubscriptions }));
vi.mock('@/lib/repos/devicesRepo', () => ({ listDevices: mocks.listDevices }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  setResolvedSnapshot: vi.fn(),
  invalidateResolvedSnapshot: vi.fn(),
}));

import { ConfigValidationError } from '@/lib/config/errors';
import { preflightProfileConfig } from '@/lib/services/configPreflight';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE = {
  id: PROFILE_ID,
  name: 'default',
  source: { type: 'none' },
  kind: 'normal',
  updated_at: 1,
} as Profile;
const BASE = [
  'mixed-port: 7890',
  'proxies: []',
  'rules:',
  '  # === ANCHOR: manual ===',
  '  # === ANCHOR: late ===',
].join('\n');

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

describe('preflightProfileConfig terminal MATCH gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigVersion.mockResolvedValue(7);
    mocks.getProfile.mockResolvedValue(PROFILE);
    mocks.getBase.mockResolvedValue({
      content: BASE,
      etag: 'base-etag',
      anchors: ['manual', 'late'],
      policies: ['DIRECT'],
      updated_at: 1,
    });
    mocks.listCollections.mockResolvedValue([]);
    mocks.listProxyGroups.mockResolvedValue([]);
    mocks.listProxyGroupTemplates.mockResolvedValue([]);
    mocks.listRuleSets.mockResolvedValue([]);
    mocks.listSubscriptions.mockResolvedValue([]);
    mocks.listDevices.mockResolvedValue([]);
  });

  it('rejects moving the active MATCH before a later-anchor rule', async () => {
    const terminal = rule({ type: 'MATCH', value: '', rank: 100 });
    const lateRule = rule({ rank: 110 });
    mocks.listRules.mockResolvedValue([terminal, lateRule]);

    const error = await preflightProfileConfig(PROFILE_ID, (state) => ({
      rules: state.rules.map((item) =>
        item.id === terminal.id ? { ...item, anchor: 'manual' } : item,
      ),
    })).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).issue).toMatchObject({
      code: 'final_rule_after_match',
      section: 'rules',
      path: 'rules[1]',
    });
  });

  it('rejects a batch-shaped candidate that adds an early MATCH before a later rule', async () => {
    mocks.listRules.mockResolvedValue([]);
    const earlyMatch = rule({ anchor: 'manual', type: 'MATCH', value: '', rank: 10 });
    const lateRule = rule({ anchor: 'late', rank: 20 });

    await expect(
      preflightProfileConfig(PROFILE_ID, () => ({ rules: [earlyMatch, lateRule] })),
    ).rejects.toMatchObject({
      issue: {
        code: 'final_rule_after_match',
        path: 'rules[1]',
      },
    });
  });

  it('rejects updating an ordinary rule into a second active MATCH', async () => {
    const ordinary = rule({ rank: 10 });
    const terminal = rule({ type: 'MATCH', value: '', rank: 100 });
    mocks.listRules.mockResolvedValue([ordinary, terminal]);

    await expect(
      preflightProfileConfig(PROFILE_ID, (state) => ({
        rules: state.rules.map((item) =>
          item.id === ordinary.id ? { ...item, type: 'MATCH', value: '' } : item,
        ),
      })),
    ).rejects.toMatchObject({
      issue: {
        code: 'final_rule_after_match',
        path: 'rules[1]',
      },
    });
  });

  it('does not treat a disabled MATCH as terminal', async () => {
    const parkedMatch = rule({
      anchor: 'manual',
      type: 'MATCH',
      value: '',
      rank: 10,
      enabled: false,
    });
    const lateRule = rule({ anchor: 'late', rank: 20 });
    mocks.listRules.mockResolvedValue([parkedMatch, lateRule]);

    await expect(preflightProfileConfig(PROFILE_ID, () => ({}))).resolves.toMatchObject({
      candidate: { rules: [parkedMatch, lateRule] },
    });
  });
});
