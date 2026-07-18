import { describe, expect, it } from 'vitest';
import {
  buildSpxQuarantine,
  buildStaleChainGroupRepair,
} from '@/lib/services/legacyChainProfileRepairService';
import type { ProxyGroup, Rule, Subscription } from '@/schemas';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const QUARANTINE_ID = '22222222-2222-4222-8222-222222222222';
const CHAIN_ID = '33333333-3333-4333-8333-333333333333';
const POOL_ID = '44444444-4444-4444-8444-444444444444';
const CONSUMER_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';
const RULE_ID = '77777777-7777-4777-8777-777777777777';

function group(input: Partial<ProxyGroup> & Pick<ProxyGroup, 'id' | 'name'>): ProxyGroup {
  return {
    type: 'select',
    kind: 'manual',
    rank: 10,
    updated_at: 1,
    ...input,
  } as ProxyGroup;
}

const staleGroups: ProxyGroup[] = [
  group({
    id: POOL_ID,
    name: 'pool-to-missing-backend',
    type: 'fallback',
    kind: 'filter',
    'include-all-proxies': true,
    filter: 'US',
  }),
  group({
    id: CHAIN_ID,
    name: 'chain:pool-to-missing-backend',
    kind: 'raw',
    proxies: ['missing-backend'],
    'dialer-proxy': 'pool-to-missing-backend',
  }),
  group({
    id: CONSUMER_ID,
    name: 'OpenAI',
    proxies: ['自动选择', 'chain:pool-to-missing-backend'],
  }),
  group({ id: OTHER_ID, name: '自动选择', proxies: ['DIRECT'] }),
];

describe('buildSpxQuarantine', () => {
  it('moves complete spx URI lines to a disabled source without exposing their content', () => {
    const marker = 'secret-spider-path';
    const source: Subscription = {
      id: SOURCE_ID,
      name: 'mynode',
      display_name: '我的节点',
      enabled: true,
      kind: 'local',
      content:
        'vless://00000000-0000-0000-0000-000000000000@good.example:443?type=tcp#good\n' +
        `vless://00000000-0000-0000-0000-000000000000@spx.example:443?security=reality&type=tcp&spx=${marker}#spx\n`,
      ttl_ms: 600_000,
      tags: [],
      operators: [],
      updated_at: 1,
    };

    const result = buildSpxQuarantine({
      source,
      allSubscriptions: [source],
      quarantineId: QUARANTINE_ID,
      updatedAt: 99,
    });

    expect(result.source.content).toContain('#good');
    expect(result.source.content).not.toContain(marker);
    expect(result.quarantine).toMatchObject({
      id: QUARANTINE_ID,
      name: 'mynode-spx-quarantine',
      enabled: false,
      kind: 'local',
      updated_at: 99,
    });
    expect(result.quarantine.content).toContain(marker);
    expect(result.summary).toEqual({
      sourceName: 'mynode',
      quarantineName: 'mynode-spx-quarantine',
      quarantinedNodes: 1,
    });
    expect(JSON.stringify(result.summary)).not.toContain(marker);
  });

  it('refuses mixed parser failures instead of dropping unrelated invalid lines', () => {
    const source: Subscription = {
      id: SOURCE_ID,
      name: 'mynode',
      enabled: true,
      kind: 'local',
      content:
        'vless://00000000-0000-0000-0000-000000000000@good.example:443?type=tcp#good\n' +
        'vless://00000000-0000-0000-0000-000000000000@spx.example:443?type=tcp&spx=value#spx\n' +
        'unknown://credential@example.invalid:443#bad\n',
      ttl_ms: 600_000,
      tags: [],
      operators: [],
    };

    expect(() =>
      buildSpxQuarantine({
        source,
        allSubscriptions: [source],
        quarantineId: QUARANTINE_ID,
        updatedAt: 99,
      }),
    ).toThrow(/spx/u);
  });

  it('turns an all-spx source into an explicit empty provider and preserves every URI', () => {
    const source: Subscription = {
      id: SOURCE_ID,
      name: 'chain-aishare',
      enabled: true,
      kind: 'local',
      content:
        'vless://00000000-0000-0000-0000-000000000000@one.example:443?type=tcp&spx=one#one\n' +
        'vless://00000000-0000-0000-0000-000000000000@two.example:443?type=tcp&spx=two#two\n',
      ttl_ms: 600_000,
      tags: [],
      operators: [],
    };

    const result = buildSpxQuarantine({
      source,
      allSubscriptions: [source],
      quarantineId: QUARANTINE_ID,
      updatedAt: 99,
    });

    expect(result.source.content).toBe('proxies: []\n');
    expect(result.quarantine.content).toContain('#one');
    expect(result.quarantine.content).toContain('#two');
    expect(result.summary.quarantinedNodes).toBe(2);
  });
});

describe('buildStaleChainGroupRepair', () => {
  const spec = {
    chainGroupId: CHAIN_ID,
    frontPoolGroupId: POOL_ID,
    consumerGroupId: CONSUMER_ID,
  };

  it('removes only the generated chain pair and its declared consumer reference', () => {
    const result = buildStaleChainGroupRepair({
      groups: staleGroups,
      rules: [],
      spec,
      updatedAt: 99,
    });

    expect(result.groupDeletes).toEqual([CHAIN_ID, POOL_ID]);
    expect(result.groupWrites).toEqual([
      expect.objectContaining({
        id: CONSUMER_ID,
        name: 'OpenAI',
        proxies: ['自动选择'],
        updated_at: 99,
      }),
    ]);
    expect(result.backendName).toBe('missing-backend');
    expect(result.summary).toEqual({
      chainGroupName: 'chain:pool-to-missing-backend',
      frontPoolGroupName: 'pool-to-missing-backend',
      consumerGroupName: 'OpenAI',
      backendName: 'missing-backend',
    });
  });

  it('refuses hidden references to either group', () => {
    const withHiddenReference = staleGroups.map((item) =>
      item.id === OTHER_ID
        ? { ...item, proxies: ['DIRECT', 'chain:pool-to-missing-backend'] }
        : item,
    );

    expect(() =>
      buildStaleChainGroupRepair({
        groups: withHiddenReference,
        rules: [],
        spec,
        updatedAt: 99,
      }),
    ).toThrow(/引用/u);
  });

  it('refuses rules targeting a group scheduled for deletion', () => {
    const rule: Rule = {
      id: RULE_ID,
      anchor: 'manual',
      type: 'MATCH',
      value: '',
      policy: 'chain:pool-to-missing-backend',
      rank: 10,
      source: 'manual',
      added_at: 1,
      updated_at: 1,
    };

    expect(() =>
      buildStaleChainGroupRepair({
        groups: staleGroups,
        rules: [rule],
        spec,
        updatedAt: 99,
      }),
    ).toThrow(/规则/u);
  });
});
