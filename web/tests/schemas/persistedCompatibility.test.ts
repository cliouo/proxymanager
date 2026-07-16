import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CollectionCreateSchema,
  CollectionSchema,
  ProxyGroupCreateSchema,
  ProxyGroupSchema,
  ProxyGroupTemplateSchema,
  ProxyGroupUpdateSchema,
  SubscriptionCreateSchema,
  SubscriptionSchema,
  mergeWithTemplate,
} from '@/schemas';
import { applyOperators } from '@/lib/proxies/operators';
import { resolveConfig } from '@/lib/engine/resolve';
import { REDIS_KEYS } from '@/lib/redis/keys';

const redisState = vi.hoisted(() => ({
  hashes: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@/lib/redis/client', () => ({
  getRedis: () => ({
    hgetall: async (key: string) => redisState.hashes.get(key) ?? null,
    hget: async (key: string, field: string) => redisState.hashes.get(key)?.[field] ?? null,
  }),
}));

import { listCollections } from '@/lib/repos/collectionsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const COLLECTION_ID = '33333333-3333-4333-8333-333333333333';
const TEMPLATE_ID = '44444444-4444-4444-8444-444444444444';

const storedGroup = {
  id: GROUP_ID,
  kind: 'raw',
  rank: 0,
  updated_at: 1,
  name: 'legacy',
  proxies: ['DIRECT'],
};

const unsafeOperator = {
  id: 'legacy-op',
  kind: 'filter-regex',
  mode: 'keep',
  pattern: '(a+)+$',
  flags: 'i',
};

describe('persisted compatibility decoders', () => {
  beforeEach(() => {
    redisState.hashes.clear();
  });

  it('keeps relay groups and templates discoverable but quarantines them from rendering', () => {
    expect(
      ProxyGroupCreateSchema.safeParse({
        name: 'legacy',
        type: 'relay',
        proxies: ['DIRECT'],
      }).success,
    ).toBe(false);

    const group = ProxyGroupSchema.parse({
      ...storedGroup,
      type: 'relay',
      'dialer-proxy': 'DIRECT',
    });
    expect(group).toMatchObject({
      type: 'select',
      legacy_type: 'relay',
      legacy_dialer_proxy: 'DIRECT',
    });
    expect(group['dialer-proxy']).toBeUndefined();
    expect(() => mergeWithTemplate(group, null)).toThrow(/stored relay proxy-group/i);

    const alreadyMarked = ProxyGroupSchema.parse({
      ...storedGroup,
      type: 'select',
      legacy_type: 'relay',
      'dialer-proxy': 'DIRECT',
    });
    expect(alreadyMarked['dialer-proxy']).toBeUndefined();
    expect(alreadyMarked.legacy_dialer_proxy).toBe('DIRECT');

    const template = ProxyGroupTemplateSchema.parse({
      id: TEMPLATE_ID,
      name: 'legacy_relay',
      updated_at: 1,
      type: 'relay',
    });
    const supportedGroup = ProxyGroupSchema.parse({ ...storedGroup, type: 'select' });
    expect(template).toMatchObject({ type: 'select', legacy_type: 'relay' });
    expect(() => mergeWithTemplate(supportedGroup, template)).toThrow(/stored relay proxy-group/i);

    expect(ProxyGroupUpdateSchema.parse({ type: 'select', legacy_type: null })).toEqual({
      type: 'select',
      legacy_type: null,
    });
  });

  it('cannot realize a quarantined relay through the pre-merge chain-wrap path', async () => {
    const group = ProxyGroupSchema.parse({
      ...storedGroup,
      name: 'LEGACY',
      type: 'relay',
      proxies: ['BACK'],
      'dialer-proxy': 'DIRECT',
    });
    const base = `mixed-port: 7890
proxies:
  - name: BACK
    type: ss
    server: example.test
    port: 443
    cipher: aes-128-gcm
    password: FAKE_ONLY

# === PROXY-GROUPS ===

rules:
  - MATCH,DIRECT
`;

    await expect(resolveConfig(base, [], [], [group], [], {})).rejects.toThrow(
      /stored relay proxy-group must be migrated/i,
    );
  });

  it('canonicalizes only valid historical comma-separated exclude-type lists', () => {
    const parsed = ProxyGroupSchema.parse({
      ...storedGroup,
      type: 'select',
      'exclude-type': 'Direct,Reject',
    });
    expect(parsed['exclude-type']).toBe('Direct|Reject');

    expect(
      ProxyGroupCreateSchema.safeParse({
        name: 'new-group',
        type: 'select',
        'exclude-type': 'Direct,Reject',
      }).success,
    ).toBe(false);

    const ambiguous = ProxyGroupSchema.parse({
      ...storedGroup,
      type: 'select',
      'exclude-type': 'Direct,Unknown',
    });
    expect(ambiguous['exclude-type']).toBe('Direct,Unknown');
  });

  it('keeps historical URL userinfo manageable while new writes reject it', () => {
    const stored = {
      id: SUBSCRIPTION_ID,
      name: 'legacy-sub',
      enabled: true,
      kind: 'remote',
      url: 'https://user:pass@example.test/sub',
      ttl_ms: 600_000,
      tags: [],
      operators: [],
    };

    expect(SubscriptionSchema.parse(stored).url).toBe(stored.url);
    expect(SubscriptionCreateSchema.safeParse(stored).success).toBe(false);
  });

  it('parks historical unsafe operators for subscriptions and collections', () => {
    const subscription = SubscriptionSchema.parse({
      id: SUBSCRIPTION_ID,
      name: 'legacy-sub',
      enabled: true,
      kind: 'remote',
      url: 'https://example.test/sub',
      ttl_ms: 600_000,
      tags: [],
      operators: [unsafeOperator],
    });
    expect(subscription.operators[0]).toMatchObject({
      disabled: true,
      compatibility_issue: 'runtime-validation-required',
      pattern: unsafeOperator.pattern,
    });
    expect(
      SubscriptionCreateSchema.safeParse({
        name: 'new-sub',
        enabled: true,
        kind: 'remote',
        url: 'https://example.test/sub',
        operators: [unsafeOperator],
      }).success,
    ).toBe(false);

    const applied = applyOperators(
      [{ name: 'aaaaaaaaaaaaaaaa', type: 'ss', server: 'example.test', port: 443 }],
      subscription.operators,
    );
    expect(applied.proxies).toHaveLength(1);
    expect(applied.steps[0]).toMatchObject({ applied: false, dropped: 0, changed: 0 });

    const collection = CollectionSchema.parse({
      id: COLLECTION_ID,
      name: 'legacy-collection',
      enabled: true,
      type: 'select',
      subscription_ids: [],
      subscription_tags: [],
      operators: [unsafeOperator],
    });
    expect(collection.operators[0]).toMatchObject({
      disabled: true,
      compatibility_issue: 'runtime-validation-required',
    });
    expect(
      CollectionCreateSchema.safeParse({
        name: 'new-collection',
        slug: 'new-collection',
        operators: [unsafeOperator],
      }).success,
    ).toBe(false);
  });

  it('keeps upgrade-era rows in all four repository lists', async () => {
    redisState.hashes.set(REDIS_KEYS.proxyGroups('profile-1'), {
      [GROUP_ID]: { ...storedGroup, type: 'relay' },
    });
    redisState.hashes.set(REDIS_KEYS.proxyGroupTemplates, {
      [TEMPLATE_ID]: {
        id: TEMPLATE_ID,
        name: 'legacy_relay',
        updated_at: 1,
        type: 'relay',
      },
    });
    redisState.hashes.set(REDIS_KEYS.subscriptions, {
      [SUBSCRIPTION_ID]: {
        id: SUBSCRIPTION_ID,
        name: 'legacy-sub',
        enabled: true,
        kind: 'remote',
        url: 'https://user:pass@example.test/sub',
        operators: [unsafeOperator],
      },
    });
    redisState.hashes.set(REDIS_KEYS.collections, {
      [COLLECTION_ID]: {
        id: COLLECTION_ID,
        name: 'legacy-collection',
        operators: [unsafeOperator],
      },
    });

    await expect(listProxyGroups('profile-1')).resolves.toMatchObject([
      { id: GROUP_ID, type: 'select', legacy_type: 'relay' },
    ]);
    await expect(listProxyGroupTemplates()).resolves.toMatchObject([
      { id: TEMPLATE_ID, type: 'select', legacy_type: 'relay' },
    ]);
    await expect(listSubscriptions()).resolves.toMatchObject([
      {
        id: SUBSCRIPTION_ID,
        url: 'https://user:pass@example.test/sub',
        operators: [{ disabled: true, compatibility_issue: 'runtime-validation-required' }],
      },
    ]);
    await expect(listCollections()).resolves.toMatchObject([
      {
        id: COLLECTION_ID,
        operators: [{ disabled: true, compatibility_issue: 'runtime-validation-required' }],
      },
    ]);
  });
});
