import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  planDirect: vi.fn(),
  executeDirect: vi.fn(),
  planLegacy: vi.fn(),
  executeLegacy: vi.fn(),
  planLegacyChain: vi.fn(),
  executeLegacyChain: vi.fn(),
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

vi.mock('@/lib/services/legacyChainProfileRepairService', () => ({
  planLegacyChainProfileRepair: mocks.planLegacyChain,
  executeLegacyChainProfileRepair: mocks.executeLegacyChain,
}));

import { getAction } from '@/lib/ai/actions/registry';

const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const US_GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DE_GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_GROUP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ETAG = 'feedfacefeedface';
const FAILURE_SIGNATURE = 'a'.repeat(64);
const OLD_US = String.raw`(?i)(🇺🇸|\bUS\b|USA|united\s?states|美)`;
const OLD_DE = String.raw`(?i)(🇩🇪|\bDE\b|DEU|德|germany)`;
const NEW_US = String.raw`(?i)(🇺🇸|(?<![A-Za-z])USA?(?![A-Za-z])|united ?states|美)`;
const NEW_DE =
  '(?:🇩🇪|德国|德國|(?<![A-Za-z])(?:DE|DEU)(?![A-Za-z])|' + '[Gg][Ee][Rr][Mm][Aa][Nn][Yy])';
const OLD_OTHER = String.raw`(?i)^(?!.*(?:🇭🇰|🇯🇵|🇺🇸|🇸🇬|🇨🇳|港|hk|hongkong|台|tw|taiwan|jp|japan|新|sg|singapore|美|\bUS\b|USA|unitedstates)).*`;
const NEW_OTHER_EXCLUDE =
  '(?i)🇭🇰|香港|(?<![A-Za-z])HKG?(?![A-Za-z])`' +
  '(?i)🇹🇼|台湾|臺灣|台北|(?<![A-Za-z])TWN?(?![A-Za-z])`' +
  '(?i)🇯🇵|日本|东京|(?<![A-Za-z])JPN?(?![A-Za-z])`' +
  '(?i)🇸🇬|新加坡|狮城|(?<![A-Za-z])SGP?(?![A-Za-z])`' +
  '(?i)🇺🇸|美国|(?<![A-Za-z])USA?(?![A-Za-z])`' +
  '🇩🇪|德国|德國|(?<![A-Za-z])(?:DE|DEU)(?![A-Za-z])|' +
  '[Gg][Ee][Rr][Mm][Aa][Nn][Yy]`🇨🇳';

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
  mocks.planLegacyChain.mockResolvedValue({
    expectedVersion: 7,
    expectedBaseEtag: ETAG,
    groups: [{ id: US_GROUP_ID }, { id: DE_GROUP_ID }],
    filterRepairBefore: [
      { name: '美国', filter: OLD_US },
      { name: '德国', filter: OLD_DE },
    ],
    filterRepairAfter: [
      { name: '美国', filter: NEW_US },
      { name: '德国', filter: NEW_DE },
    ],
    summary: {
      directMigration: { ...summary, expectedVersion: 7 },
      repairedFilterGroups: ['美国', '德国'],
      spxQuarantine: {
        sourceName: 'mynode',
        quarantineName: 'mynode-spx-quarantine',
        quarantinedNodes: 4,
      },
      staleChain: {
        chainGroupName: 'chain:pool-to-missing-backend',
        frontPoolGroupName: 'pool-to-missing-backend',
        consumerGroupName: 'OpenAI',
        backendName: 'missing-backend',
      },
    },
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

  it('keeps a realistic legacy-repair confirmation below the MCP host message limit', async () => {
    const action = getAction('repair_legacy_profile');
    expect(action?.risk).toBe('write');
    if (!action || action.risk !== 'write') throw new Error('write action not registered');

    const groupNames = [
      '默认',
      'Telegram',
      '哔哩哔哩',
      'YouTube',
      'OpenAI',
      'Gemini',
      'PayPal',
      'Discord',
      '国内',
      '其他',
    ];
    mocks.planLegacy.mockResolvedValueOnce({
      summary: {
        ...summary,
        baseLiteralGroupReferences: 1,
        groupsTouched: groupNames.length,
        groupMemberReferences: groupNames.length,
        rulesTouched: 1,
        enabledRulesTouched: 1,
        groupNames,
        isolatedSubscriptionFailures: 5,
      },
      expectedVersion: 314,
      expectedBaseEtag: ETAG,
      subscriptionFailureSignature: FAILURE_SIGNATURE,
      groups: [...groupNames, '美国', '德国', '其它地区'].map((name) => ({ name })),
      filterRepairBefore: [
        { name: '美国', filter: OLD_US },
        { name: '德国', filter: OLD_DE },
        { name: '其它地区', filter: OLD_OTHER },
      ],
      filterRepairAfter: [
        { name: '美国', filter: NEW_US },
        { name: '德国', filter: NEW_DE },
        { name: '其它地区', filter: '^.*$', 'exclude-filter': NEW_OTHER_EXCLUDE },
      ],
    });

    const input = action.input.parse({
      alias: '直连',
      repairs: [
        { id: US_GROUP_ID, filter: NEW_US },
        { id: DE_GROUP_ID, filter: NEW_DE },
        { id: OTHER_GROUP_ID, filter: '^.*$', exclude_filter: NEW_OTHER_EXCLUDE },
      ],
      expected_version: 314,
      expected_base_etag: ETAG,
    });
    const preview = await action.preview(ctx, input);
    const serializedDiff = JSON.stringify(preview.diff);
    const visibleDiff = `${String((preview.diff as Record<string, unknown>).beforeYaml)}\n${String(
      (preview.diff as Record<string, unknown>).afterYaml,
    )}`;

    for (const value of [
      ...groupNames,
      '美国',
      '德国',
      '其它地区',
      OLD_US,
      OLD_DE,
      OLD_OTHER,
      NEW_US,
      NEW_DE,
      NEW_OTHER_EXCLUDE,
    ]) {
      expect(visibleDiff).toContain(value);
    }
    expect(serializedDiff.length).toBeLessThanOrEqual(1800);
  });

  it('shows source quarantine, stale-chain deletion and exact filters in one compact card', async () => {
    const action = getAction('repair_legacy_chain_profile');
    expect(action?.risk).toBe('write');
    if (!action || action.risk !== 'write') throw new Error('write action not registered');

    const groupNames = [
      '默认',
      'Telegram',
      '哔哩哔哩',
      'YouTube',
      'OpenAI',
      'Gemini',
      'PayPal',
      'Discord',
      '国内',
      '其他',
    ];
    mocks.planLegacyChain.mockResolvedValueOnce({
      expectedVersion: 7,
      expectedBaseEtag: ETAG,
      filterRepairBefore: [
        { name: '美国', filter: OLD_US },
        { name: '德国', filter: OLD_DE },
        { name: '其它地区', filter: OLD_OTHER },
      ],
      filterRepairAfter: [
        { name: '美国', filter: NEW_US },
        { name: '德国', filter: NEW_DE },
        { name: '其它地区', filter: '^.*$', 'exclude-filter': NEW_OTHER_EXCLUDE },
      ],
      summary: {
        directMigration: {
          ...summary,
          expectedVersion: 7,
          groupsTouched: groupNames.length,
          groupNames,
        },
        repairedFilterGroups: ['美国', '德国', '其它地区'],
        spxQuarantine: {
          sourceName: 'chain-aishare',
          quarantineName: 'chain-aishare-spx-quarantine',
          quarantinedNodes: 2,
          affectedProfiles: ['fxn', 'wjr'],
        },
        staleChain: {
          chainGroupName: 'chain:pool-to-missing-backend',
          frontPoolGroupName: 'pool-to-missing-backend',
          consumerGroupName: 'OpenAI',
          backendName: 'missing-backend',
        },
      },
    });

    const input = action.input.parse({
      alias: '直连',
      repairs: [
        { id: US_GROUP_ID, filter: NEW_US },
        { id: DE_GROUP_ID, filter: NEW_DE },
        { id: OTHER_GROUP_ID, filter: '^.*$', exclude_filter: NEW_OTHER_EXCLUDE },
      ],
      quarantine_spx_subscription_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      stale_chain: {
        chain_group_id: '11111111-1111-4111-8111-111111111111',
        front_pool_group_id: '22222222-2222-4222-8222-222222222222',
        consumer_group_id: '33333333-3333-4333-8333-333333333333',
      },
      expected_version: 7,
      expected_base_etag: ETAG,
    });
    const preview = await action.preview(ctx, input);
    const diff = preview.diff as Record<string, unknown>;
    const visible = `${String(diff.beforeYaml)}\n${String(diff.afterYaml)}`;

    for (const value of [
      '美国',
      '德国',
      OLD_US,
      OLD_DE,
      NEW_US,
      NEW_DE,
      OLD_OTHER,
      NEW_OTHER_EXCLUDE,
      'chain-aishare',
      'chain-aishare-spx-quarantine',
      'fxn',
      'wjr',
      'chain:pool-to-missing-backend',
      'pool-to-missing-backend',
      'OpenAI',
      'missing-backend',
    ]) {
      expect(visible).toContain(value);
    }
    expect(JSON.stringify(diff).length).toBeLessThanOrEqual(1800);
    expect(preview.confirmation).toEqual({ configVersion: 7 });
  });

  it('refuses legacy-chain execution without the confirmation-card version guard', async () => {
    const action = getAction('repair_legacy_chain_profile');
    expect(action?.risk).toBe('write');
    if (!action || action.risk !== 'write') throw new Error('write action not registered');
    const input = action.input.parse({
      alias: '直连',
      repairs: [
        { id: US_GROUP_ID, filter: NEW_US },
        { id: DE_GROUP_ID, filter: NEW_DE },
      ],
      quarantine_spx_subscription_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expected_version: 7,
      expected_base_etag: ETAG,
    });

    await expect(action.execute(ctx, input)).rejects.toMatchObject({
      problem: { status: 409 },
    });
    expect(mocks.executeLegacyChain).not.toHaveBeenCalled();
  });
});
