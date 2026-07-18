import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  planDirect: vi.fn(),
  executeDirect: vi.fn(),
  planLegacy: vi.fn(),
  executeLegacy: vi.fn(),
}));

vi.mock('@/lib/services/directMigrationService', () => ({
  BUILTIN_DIRECT: 'DIRECT',
  planDirectAliasMigration: mocks.planDirect,
  executeDirectAliasMigration: mocks.executeDirect,
}));

vi.mock('@/lib/services/legacyProfileRepairService', () => ({
  planLegacyProfileRepair: mocks.planLegacy,
  executeLegacyProfileRepair: mocks.executeLegacy,
}));

import { getAction } from '@/lib/ai/actions/registry';

const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const US_GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DE_GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ETAG = 'feedfacefeedface';
const FAILURE_SIGNATURE = 'a'.repeat(64);
const OLD_US = String.raw`(?i)(🇺🇸|\bUS\b|美)`;
const OLD_DE = String.raw`(?i)(🇩🇪|\bDE\b|德)`;
const NEW_US = String.raw`(?i)(🇺🇸|(?<![A-Za-z])USA?(?![A-Za-z])|美)`;
const NEW_DE = String.raw`(?i)(🇩🇪|(?<![A-Za-z])DEU?(?![A-Za-z])|德)`;

const summary = {
  alias: '直连',
  replacement: 'DIRECT' as const,
  removedProxyFields: ['name', 'type', 'udp'],
  baseProxyDialerReferences: 0,
  baseProviderReferences: 0,
  baseLiteralGroupReferences: 0,
  baseLiteralRuleReferences: 0,
  groupsTouched: 1,
  groupMemberReferences: 1,
  groupOtherReferences: 0,
  inheritedTemplateOverrides: 0,
  rulesTouched: 0,
  enabledRulesTouched: 0,
  disabledRulesTouched: 0,
  groupNames: ['出口'],
  isolatedSubscriptionFailures: 1,
};

const ctx = { profileId: PROFILE_ID, actor: 'test-actor' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planDirect.mockResolvedValue({
    summary,
    expectedVersion: 7,
    expectedBaseEtag: ETAG,
    subscriptionFailureSignature: FAILURE_SIGNATURE,
  });
  mocks.planLegacy.mockResolvedValue({
    summary,
    expectedVersion: 7,
    expectedBaseEtag: ETAG,
    subscriptionFailureSignature: FAILURE_SIGNATURE,
    groups: [{ name: '出口' }, { name: '美国' }, { name: '德国' }],
    filterRepairBefore: [
      { name: '美国', filter: OLD_US },
      { name: '德国', filter: OLD_DE },
    ],
    filterRepairAfter: [
      { name: '美国', filter: NEW_US },
      { name: '德国', filter: NEW_DE },
    ],
  });
});

describe('migration confirmation diffs', () => {
  it('routes the direct migration through the YAML diff renderer', async () => {
    const action = getAction('migrate_direct_alias');
    expect(action?.risk).toBe('write');
    if (!action || action.risk !== 'write') throw new Error('write action not registered');

    const input = action.input.parse({
      alias: '直连',
      expected_version: 7,
      expected_base_etag: ETAG,
    });
    const preview = await action.preview(ctx, input);
    const diff = preview.diff as Record<string, unknown>;

    expect(diff).not.toHaveProperty('before');
    expect(diff).not.toHaveProperty('after');
    expect(diff.beforeYaml).toContain('name: 直连');
    expect(diff.afterYaml).toContain('allKnownReferences: DIRECT');
    expect(diff.afterYaml).toContain('isolatedExistingFailures: 1');
    expect(diff.afterYaml).toContain('migrationDoesNotRepairSubscriptions: true');
    expect(preview.confirmation).toEqual({
      subscriptionFailureSignature: FAILURE_SIGNATURE,
    });
  });

  it('shows every target group and exact before/after regex in the confirmation card', async () => {
    const action = getAction('repair_legacy_profile');
    expect(action?.risk).toBe('write');
    if (!action || action.risk !== 'write') throw new Error('write action not registered');

    const input = action.input.parse({
      alias: '直连',
      repairs: [
        { id: US_GROUP_ID, filter: NEW_US },
        { id: DE_GROUP_ID, filter: NEW_DE },
      ],
      expected_version: 7,
      expected_base_etag: ETAG,
    });
    const preview = await action.preview(ctx, input);
    const diff = preview.diff as Record<string, unknown>;
    const beforeYaml = String(diff.beforeYaml);
    const afterYaml = String(diff.afterYaml);

    expect(diff).not.toHaveProperty('before');
    expect(diff).not.toHaveProperty('after');
    for (const value of ['美国', '德国', OLD_US, OLD_DE]) expect(beforeYaml).toContain(value);
    for (const value of ['美国', '德国', NEW_US, NEW_DE]) expect(afterYaml).toContain(value);
    expect(afterYaml).toContain('isolatedExistingFailures: 1');
    expect(afterYaml).toContain('migrationDoesNotRepairSubscriptions: true');
    expect(preview.confirmation).toEqual({
      subscriptionFailureSignature: FAILURE_SIGNATURE,
    });
  });
});
