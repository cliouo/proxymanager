import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Collection, Profile, Subscription } from '@/schemas';

const mocks = vi.hoisted(() => ({
  getBase: vi.fn(),
  getConfigVersion: vi.fn(),
  getOrdinalGeneration: vi.fn(),
  getProfile: vi.fn(),
  getCollection: vi.fn(),
  listCollections: vi.fn(),
  listDevices: vi.fn(),
  listProxyGroups: vi.fn(),
  listProxyGroupTemplates: vi.fn(),
  listRules: vi.fn(),
  listRuleSets: vi.fn(),
  listSubscriptions: vi.fn(),
  getFetchCache: vi.fn(),
  setFetchCache: vi.fn(),
}));

vi.mock('@/lib/repos/baseRepo', () => ({ getBase: mocks.getBase }));
vi.mock('@/lib/repos/configVersionRepo', () => ({
  getConfigVersion: mocks.getConfigVersion,
}));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: mocks.getProfile, listProfiles: async () => [] }));
vi.mock('@/lib/repos/collectionsRepo', () => ({
  getCollection: mocks.getCollection,
  listCollections: mocks.listCollections,
}));
vi.mock('@/lib/repos/devicesRepo', () => ({ listDevices: mocks.listDevices }));
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
vi.mock('@/lib/repos/resolvedRepo', () => ({
  setResolvedSnapshot: vi.fn(async () => undefined),
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/repos/fetchCacheRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/fetchCacheRepo')>();
  return {
    ...actual,
    getFetchCache: mocks.getFetchCache,
    setFetchCache: mocks.setFetchCache,
  };
});
vi.mock('@/lib/repos/nodeOrdinalRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/nodeOrdinalRepo')>();
  return {
    ...actual,
    getOrdinalGeneration: mocks.getOrdinalGeneration,
    readOrdinalStore: vi.fn(async (sourceKeys: string[]) => ({
      assignments: new Map(sourceKeys.map((key) => [key, new Map()])),
      invalidFields: new Map(sourceKeys.map((key) => [key, new Set()])),
      duplicateSources: new Set(),
      counters: new Map(sourceKeys.map((key) => [key, null])),
      hashBroken: false,
      counterBroken: new Set(),
      hlenBySource: new Map(sourceKeys.map((key) => [key, 0])),
      globalSize: 0,
      generation: 0,
    })),
  };
});

import { nodeFingerprint } from '@/lib/proxies/naming';
import { analyzeSourceFacts } from '@/lib/proxies/namingHealth';
import { exportCollectionNodes, exportSubscriptionNodes, mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { previewNamingCollection } from '@/lib/services/namingPreviewService';
import { resolveConfig } from '@/lib/engine/resolve';
import {
  preflightProfileConfig,
  resolveSubscriptionForPreflight,
} from '@/lib/services/configPreflight';
import { commitUnderPipelineGate } from '@/lib/services/nodePipelineSaveGate';
import {
  createOrdinalPlanningSession,
  type OrdinalReservationPlan,
} from '@/lib/services/nodeOrdinalService';

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COLLECTION_ID = '22222222-2222-4222-8222-222222222222';
const DIRECT_PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COLLECTION_PROFILE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BASE = `mixed-port: 7890
proxies:
  - name: 直连
    type: direct
proxy-groups:
  - name: 默认
    type: select
    proxies: [直连]
rules:
  - MATCH,默认
`;
const US_NODE = {
  name: '美国 alpha',
  type: 'ss',
  server: 'us.example',
  port: 8388,
  cipher: 'aes-128-gcm',
  password: 'pw',
};
const JP_NODE = {
  name: '日本 beta',
  type: 'ss',
  server: 'jp.example',
  port: 8388,
  cipher: 'aes-128-gcm',
  password: 'pw',
};

function profile(id: string, source: Profile['source']): Profile {
  return { id, name: id, source, updated_at: 1 } as Profile;
}

describe('outer pipeline save integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const subscription: Subscription = {
      id: SUB_ID,
      name: 'airport-a',
      display_name: '机场A',
      enabled: true,
      kind: 'remote',
      url: 'https://upstream.example/sub',
      ttl_ms: 60_000,
      tags: [],
      operators: [{ id: 'keep-jp', kind: 'filter-regex', mode: 'keep', pattern: '日本' }],
    } as Subscription;
    const collection: Collection = {
      id: COLLECTION_ID,
      name: '聚合池',
      slug: 'pool',
      enabled: true,
      type: 'select',
      subscription_ids: [SUB_ID],
      subscription_tags: [],
      operators: [
        {
          id: 'managed',
          kind: 'rename-template',
          template: '${region} ${index}',
          recognitionRules: [],
        },
      ],
    };
    const profiles = new Map<string, Profile>([
      [DIRECT_PROFILE_ID, profile(DIRECT_PROFILE_ID, { type: 'subscription', id: SUB_ID })],
      [
        COLLECTION_PROFILE_ID,
        profile(COLLECTION_PROFILE_ID, { type: 'collection', id: COLLECTION_ID }),
      ],
    ]);
    mocks.getConfigVersion.mockResolvedValue(7);
    mocks.getOrdinalGeneration.mockResolvedValue(0);
    mocks.getProfile.mockImplementation(async (id: string) => profiles.get(id) ?? null);
    mocks.getBase.mockResolvedValue({
      content: BASE,
      etag: 'base-etag',
      anchors: [],
      policies: ['默认'],
      updated_at: 1,
    });
    mocks.listSubscriptions.mockResolvedValue([subscription]);
    mocks.listCollections.mockResolvedValue([collection]);
    mocks.listDevices.mockResolvedValue([]);
    mocks.listProxyGroups.mockResolvedValue([]);
    mocks.listProxyGroupTemplates.mockResolvedValue([]);
    mocks.listRules.mockResolvedValue([]);
    mocks.listRuleSets.mockResolvedValue([]);
    // Valid but expired: preflight must refresh once and may not accept this
    // old cache as proof of the candidate.
    mocks.getFetchCache.mockResolvedValue({
      content: stringify({ proxies: [US_NODE, JP_NODE] }, { lineWidth: 0 }),
      proxy_count: 2,
      fetched_at: 0,
    });
    mocks.setFetchCache.mockResolvedValue(undefined);
  });

  it('fetches once for two profiles and preserves the full raw ordinal domain through source filter to collection', async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCount += 1;
        const proxies = fetchCount === 1 ? [US_NODE, JP_NODE] : [JP_NODE, US_NODE];
        return new Response(stringify({ proxies }, { lineWidth: 0 }), { status: 200 });
      }),
    );
    let committedPlan: OrdinalReservationPlan | undefined;
    const affected = [
      profile(DIRECT_PROFILE_ID, { type: 'subscription', id: SUB_ID }),
      profile(COLLECTION_PROFILE_ID, { type: 'collection', id: COLLECTION_ID }),
    ];

    await commitUnderPipelineGate({
      planningVersion: 7,
      affected,
      candidateSubscriptions: (current) => current,
      commit: async (_version, ordinalPlan) => {
        committedPlan = ordinalPlan;
        return { ok: true };
      },
    });

    expect(fetchCount).toBe(1);
    expect(mocks.getFetchCache).toHaveBeenCalledTimes(1);
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
    expect(committedPlan).toBeDefined();
    expect(committedPlan?.sources).toHaveLength(1);
    expect(committedPlan?.sources[0].fields.map((field) => field.ordinal)).toEqual([1, 2]);
    expect(
      committedPlan?.sources[0].fields.find(
        (field) => field.fingerprint === nodeFingerprint(JP_NODE),
      )?.ordinal,
    ).toBe(2);
  });

  it('ordinary profile preflight matches serving semantics through source filter to collection naming', async () => {
    const localSubscription = {
      ...(await mocks.listSubscriptions())[0],
      kind: 'local',
      url: undefined,
      content: stringify({ proxies: [US_NODE, JP_NODE] }, { lineWidth: 0 }),
    } as Subscription;
    const collections = (await mocks.listCollections()) as Collection[];
    mocks.listSubscriptions.mockResolvedValue([localSubscription]);

    const checked = await preflightProfileConfig(COLLECTION_PROFILE_ID, () => ({}));

    const ordinalPlanningSession = await createOrdinalPlanningSession([localSubscription.name]);
    const expected = await resolveConfig(BASE, [], [localSubscription], [], [], {
      collections,
      boundSource: { type: 'collection', id: COLLECTION_ID },
      persistSnapshot: false,
      persistOrdinals: false,
      ordinalPlanningSession,
      subscriptionResolver: (subscription, resolverOptions) =>
        resolveSubscriptionForPreflight(subscription, {
          ...(resolverOptions?.ordinalPlanningSession
            ? { ordinalPlanningSession: resolverOptions.ordinalPlanningSession }
            : {}),
        }),
    });

    expect(expected.nodeNames).toContain('日本 02');
    expect(checked.buildId).toBe(expected.buildId);
  });

  async function aggregateFixture() {
    const raw = { ...US_NODE, name: '美国 edge 01' };
    const subscription: Subscription = {
      ...(await mocks.listSubscriptions())[0], kind: 'local', url: undefined,
      content: stringify({ proxies: [raw, { ...JP_NODE, name: '香港 02' }] }),
      operators: [
        { id: 'local-edit', kind: 'rename-regex', pattern: '美国', replacement: '日本' },
        { id: 'local-filter', kind: 'filter-regex', mode: 'keep', pattern: '日本' },
        { id: 'member-naming', kind: 'rename-template', template: 'member ${region} ${index}', recognitionRules: [],
          nodeFacts: { [nodeFingerprint(raw)!]: { tags: ['家宽'] } } },
      ],
    };
    const collection: Collection = {
      ...(await mocks.listCollections())[0],
      operators: [{ id: 'collection-naming', kind: 'rename-template',
        template: '${region}${?tags: · ${tags}}${?note: · ${note}} · ${index}', recognitionRules: [] }],
    };
    mocks.listSubscriptions.mockResolvedValue([subscription]);
    mocks.listCollections.mockResolvedValue([collection]);
    mocks.getCollection.mockResolvedValue(collection);
    return { raw, subscription, collection };
  }

  it('renders members once using manual edits and identity facts, with export/preview/serve/preflight parity', async () => {
    const { subscription, collection } = await aggregateFixture();
    const stored = structuredClone(subscription.operators);
    const exported = await exportCollectionNodes(collection, [subscription], { writeCache: false });
    expect(exported.proxies.map((node) => node.name)).toEqual(['日本 · 家宽 · edge · 01']);
    const preview = await previewNamingCollection(collection.id, collection.operators);
    expect(preview.before.names).toEqual(['日本 edge 01']);
    expect(preview.after.names).toEqual(exported.proxies.map((node) => node.name));
    const served = await resolveConfig(BASE, [], [subscription], [], [], {
      collections: [collection], boundSource: { type: 'collection', id: collection.id },
      persistSnapshot: false, persistOrdinals: false,
    });
    expect(served.nodeNames).toContain('日本 · 家宽 · edge · 01');
    const checked = await preflightProfileConfig(COLLECTION_PROFILE_ID, () => ({}));
    expect(checked.buildId).toBe(served.buildId);
    expect((await exportCollectionNodes(collection, [subscription], { writeCache: false })).yaml).toBe(exported.yaml);
    expect((await exportSubscriptionNodes(subscription, { writeCache: false })).proxies[0].name).toBe('member 日本 01');
    expect((await exportCollectionNodes({ ...collection, operators: [] }, [subscription], { writeCache: false })).proxies[0].name).toBe('member 日本 01');
    expect(subscription.operators).toEqual(stored);
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
  });

  it('collection facts override inherited member facts in rendering and health', async () => {
    const { raw, subscription, collection } = await aggregateFixture();
    const naming = collection.operators[0];
    if (naming.kind !== 'rename-template') throw new Error('expected template');
    naming.nodeFacts = { [nodeFingerprint(raw)!]: { tags: ['IEPL'] } };
    const exported = await exportCollectionNodes(collection, [subscription], { writeCache: false });
    expect(exported.proxies[0].name).toBe('日本 · IEPL · edge · 01');
    const { merged } = await mergeCollectionMemberProxies(collection, [subscription], { writeCache: false });
    const inherited = analyzeSourceFacts(merged);
    expect(inherited[0].fields.find((field) => field.field === 'tags')?.samples[0].value).toBe('家宽');
    const overridden = analyzeSourceFacts(merged, { nodeFacts: naming.nodeFacts });
    expect(overridden[0].fields.find((field) => field.field === 'tags')?.samples[0].value).toBe('IEPL');
  });

  it('keeps post-template edits chained and surfaces the member warning', async () => {
    const { subscription, collection } = await aggregateFixture();
    subscription.operators.push({ id: 'after', kind: 'rename-regex', pattern: 'member 日本', replacement: '新加坡' });
    const preview = await previewNamingCollection(collection.id, collection.operators);
    expect(preview.before.names).toEqual(['新加坡 01']);
    expect(preview.after.names).toEqual(['新加坡 · 家宽 · 01']);
    expect(preview.issues).toContainEqual({ code: 'member-post-template-rename', memberId: SUB_ID,
      message: 'post-template rename rows; convert to facts/rules' });
    expect((await exportCollectionNodes(collection, [subscription], { writeCache: false })).proxies[0].name).toBe('新加坡 · 家宽 · 01');
  });

  it('separates direct and collection preflight outputs while sharing immutable raw bytes', async () => {
    const { raw, subscription } = await aggregateFixture();
    const remote = { ...subscription, kind: 'remote', url: 'https://upstream.example/sub', content: undefined } as Subscription;
    const fetcher = vi.fn(async () => new Response(stringify({ proxies: [raw] })));
    vi.stubGlobal('fetch', fetcher);
    try {
      const subscriptionSnapshot = new Map();
      const direct = await resolveSubscriptionForPreflight(remote, { subscriptionSnapshot });
      const member = await resolveSubscriptionForPreflight(remote, { subscriptionSnapshot, managedCollection: true });
      expect(direct.proxies[0].name).toBe('member 日本 01');
      expect(member.proxies[0].name).toBe('日本 edge 01');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mocks.setFetchCache).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
