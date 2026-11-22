import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Collection, Profile, Subscription } from '@/schemas';

const mocks = vi.hoisted(() => ({
  getBase: vi.fn(),
  getConfigVersion: vi.fn(),
  getOrdinalGeneration: vi.fn(),
  getProfile: vi.fn(),
  listProfiles: vi.fn(),
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
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: mocks.getProfile, listProfiles: mocks.listProfiles }));
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
import { loadNamingCandidateContext, publicGroupingPreview } from '@/lib/services/namingCandidateService';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
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
    mocks.listProfiles.mockResolvedValue([...profiles.values()]);
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

  it('generates from the real after-pool only for the group-less shared consumer and preflights its final config', async () => {
    const { subscription } = await aggregateFixture();
    mocks.getBase.mockResolvedValue({ content: 'mixed-port: 7890\n# === PROXY-GROUPS ===\nrules:\n  - MATCH,DIRECT\n', etag: 'base', updated_at: 1 });
    mocks.listProxyGroups.mockImplementation(async (id: string) => id === DIRECT_PROFILE_ID ? [{ id: DIRECT_PROFILE_ID, name: 'Existing', kind: 'filter', type: 'select',
      rank: 0, updated_at: 1, 'include-all-proxies': true }] : []);
    const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
    expect(context.hasGrouplessProfiles).toBe(true);
    const preview = await context.grouping();
    expect(preview.blocked).toBe(false);
    expect(preview.profiles).toHaveLength(1);
    expect(preview.purposes.find((p) => p.id === 'region')).toMatchObject({ count: 1, selected: true });
    expect(preview.purposes.find((p) => p.id === 'residential')).toMatchObject({ count: 1, selected: false });
    expect(preview.purposes.find((p) => p.id === 'dedicated')).toMatchObject({ count: 0, selected: false });
    const next: Subscription = { ...subscription, operators: subscription.operators.map((row) => row.kind === 'rename-template' ? { ...row, template: preview.template } : row) };
    const changes = await context.groupChanges(next, preview.template, ['region']);
    expect(changes.map((c) => c.profileId)).toEqual([COLLECTION_PROFILE_ID]);
    expect(changes[0].createdGroups?.map((g) => g.name)).toEqual(['节点选择', '🇯🇵 日本']);
    const checked = await preflightProfileConfig(COLLECTION_PROFILE_ID, () => ({ proxyGroups: changes[0].createdGroups!, subscriptions: [next] }), {
      subscriptionSnapshot: context.subscriptionSnapshot, ordinalPlanningSession: context.ordinalPlanningSession,
    });
    expect(checked.configVersion).toBe(7);
    const sources = await context.grouping(['source']);
    expect(sources.blocked).toBe(false);
    expect(sources.profiles[0].groups[1].kind).toBe('single-sub');
    expect(JSON.stringify(publicGroupingPreview(sources))).not.toContain('bound_subscription_id');
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
  });

  it('does not offer generation to profiles whose base already supplies groups', async () => {
    await aggregateFixture();
    const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
    expect(context.hasGrouplessProfiles).toBe(false);
    expect(await context.grouping(['region'])).toMatchObject({ profiles: [], blocked: true });
  });

  it('preselects non-region purposes at two real rendered nodes and derives source/tag/rate fields', async () => {
    const subscription: Subscription = { ...(await mocks.listSubscriptions())[0], kind: 'local', url: undefined,
      content: stringify({ proxies: [{ ...US_NODE, name: 'HK 家宽 0.5x 01' }, { ...JP_NODE, name: 'JP 家宽 0.5x 02' }] }), operators: [] };
    mocks.listSubscriptions.mockResolvedValue([subscription]);
    mocks.listProfiles.mockResolvedValue([profile(DIRECT_PROFILE_ID, { type: 'subscription', id: SUB_ID })]);
    mocks.getBase.mockResolvedValue({ content: 'proxies: []\n# === PROXY-GROUPS ===\nrules: ["MATCH,DIRECT"]\n', etag: 'base', updated_at: 1 });
    const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
    const preview = await context.grouping();
    expect(preview.blocked).toBe(false);
    expect(preview.purposes.filter((p) => p.selected).map((p) => p.id)).toEqual(['region', 'source', 'low-rate', 'residential']);
    expect(preview.purposes.filter((p) => p.id !== 'dedicated').every((p) => p.count === 2)).toBe(true);
    expect(preview.template).toContain('${source}');
    expect(preview.template).toContain('${tags}');
    expect(preview.template).toContain('${rate}');
    expect(preview.profiles[0].groups.slice(1).every((g) => g.kind === 'filter')).toBe(true);
  });

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
      message: 'post-template name-dependent rows; convert to facts/rules' });
    expect((await exportCollectionNodes(collection, [subscription], { writeCache: false })).proxies[0].name).toBe('新加坡 · 家宽 · 01');
  });

  it('keeps a template prefix visible to a downstream keep filter', async () => {
    const { subscription, collection } = await aggregateFixture();
    subscription.operators.push({ id: 'after', kind: 'filter-regex', mode: 'keep', pattern: '^member 日本 ' });
    const preview = await previewNamingCollection(collection.id, collection.operators);
    expect(preview.before.names).toEqual(['member 日本 01']);
    expect(preview.after.names).toHaveLength(1);
    expect(preview.issues).toContainEqual({ code: 'member-post-template-rename', memberId: SUB_ID,
      message: 'post-template name-dependent rows; convert to facts/rules' });
    expect((await exportCollectionNodes(collection, [subscription], { writeCache: false })).proxyCount).toBe(1);
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

  it.each([false, true])('matches serving fallback for duplicate remote names with managed-first=%s', async (managedFirst) => {
    const { subscription } = await aggregateFixture();
    const remote = { ...subscription, operators: [], kind: 'remote', url: 'https://upstream.example/sub', content: undefined } as Subscription;
    const fresh = [{ ...US_NODE, name: 'edge' }, { ...JP_NODE, name: 'edge' }];
    const fetcher = vi.fn(async () => new Response(stringify({ proxies: fresh })));
    vi.stubGlobal('fetch', fetcher);
    try {
      const serving = await resolveSubscriptionProxies(remote, { writeCache: false, recordHealth: false });
      expect(serving.stale).toBe(true);
      expect(serving.proxies.map((p) => p.name)).toEqual([US_NODE.name, JP_NODE.name]);
      fetcher.mockClear();
      const subscriptionSnapshot = new Map();
      const managed = () => resolveSubscriptionForPreflight(remote, { subscriptionSnapshot, managedCollection: true });
      if (managedFirst) expect((await managed()).proxies.map((p) => p.name)).toEqual(['edge', 'edge']);
      const direct = await resolveSubscriptionForPreflight(remote, { subscriptionSnapshot });
      expect(direct.stale).toBe(true);
      expect(direct.proxies).toEqual(serving.proxies);
      if (!managedFirst) expect((await managed()).proxies.map((p) => p.name)).toEqual(['edge', 'edge']);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mocks.setFetchCache).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('plans filter recovery against the serving base-proxy suffix', async () => {
    const { subscription } = await aggregateFixture();
    const base = BASE.replace('proxies:', 'proxies:\n  - name: 日本\n    type: direct');
    mocks.getBase.mockResolvedValue({ content: base, etag: 'base', updated_at: 1 });
    mocks.listProfiles.mockResolvedValue([profile(DIRECT_PROFILE_ID, { type: 'subscription', id: SUB_ID })]);
    mocks.listProxyGroups.mockResolvedValue([{ id: DIRECT_PROFILE_ID, name: 'Members', kind: 'raw', type: 'select', rank: 0, updated_at: 1,
      'include-all-proxies': true, filter: '^member 日本 ' }]);
    const next: Subscription = { ...subscription, operators: subscription.operators.map((row) => row.kind === 'rename-template' ? { ...row, template: '${region}' } : row) };
    const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
    const candidate = await context.analyze(next, { id: 'test', title: 'Test', template: '${region}' });
    const served = await resolveConfig(base, [], [next], [], [], {
      boundSource: { type: 'subscription', id: SUB_ID }, persistSnapshot: false, persistOrdinals: false,
    });
    const finalName = `日本 · ${subscription.display_name?.trim() || subscription.name}`;
    expect(served.nodeNames).toContain(finalName);
    expect(candidate.groups[0].migration).toBeUndefined();
    expect(candidate.groups[0].broken).toBe(true);
  });

  it('tracks cross-source collision suffixes in counts, filters and exact references', async () => {
    const { subscription, collection } = await aggregateFixture();
    const backup: Subscription = { ...subscription, id: COLLECTION_PROFILE_ID, name: '机场B', display_name: 'Backup',
      content: stringify({ proxies: [{ ...JP_NODE, name: '日本', server: 'backup.example' }] }), operators: [] };
    const col = { ...collection, subscription_ids: [SUB_ID, backup.id], operators: [] };
    mocks.listSubscriptions.mockResolvedValue([subscription, backup]);
    mocks.listCollections.mockResolvedValue([col]);
    mocks.listProfiles.mockResolvedValue([profile(COLLECTION_PROFILE_ID, { type: 'collection', id: col.id })]);
    mocks.listProxyGroups.mockResolvedValue([
      { id: DIRECT_PROFILE_ID, name: 'Dynamic', kind: 'raw', type: 'select', rank: 0, updated_at: 1, 'include-all-proxies': true, filter: '^日本$' },
      { id: COLLECTION_PROFILE_ID, name: 'Manual', kind: 'manual', type: 'select', rank: 1, updated_at: 1, proxies: ['日本'] },
    ]);
    mocks.listRules.mockResolvedValue([{ id: DIRECT_PROFILE_ID, policy: '日本' }]);
    const next: Subscription = { ...subscription, operators: subscription.operators.map((row) => row.kind === 'rename-template' ? { ...row, template: '${region}' } : row) };
    const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
    const candidate = await context.analyze(next, { id: 'test', title: 'Test', template: '${region}' });
    const served = await resolveConfig(BASE, [], [next, backup], [], [], {
      collections: [col], boundSource: { type: 'collection', id: col.id }, persistSnapshot: false, persistOrdinals: false,
    });
    expect(served.nodeNames).toContain('日本 · Backup');
    expect(candidate.groups[0].migration).toBeUndefined();
    expect(candidate.groups[0].broken).toBe(true);
    expect(candidate.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manual', before: '日本', after: '日本 · Backup', blocked: false }),
      expect.objectContaining({ kind: 'rule', before: '日本', after: '日本 · Backup', blocked: false }),
    ]));
    const changes = context.changesFor(candidate)[0];
    expect(changes.groups.find((g) => g.before.id === COLLECTION_PROFILE_ID)?.after.proxies).toEqual(['日本 · Backup']);
    expect(changes.rules[0].after.policy).toBe('日本 · Backup');
  });

  it.each([false, true])('rewrites a renamed empty-fallback before final preflight (inherited: %s)', async (inherited) => {
    const { subscription } = await aggregateFixture();
    mocks.getBase.mockResolvedValue({ content: 'proxies: []\n# === PROXY-GROUPS ===\nrules: ["MATCH,DIRECT"]\n', etag: 'base', updated_at: 1 });
    mocks.listProfiles.mockResolvedValue([profile(DIRECT_PROFILE_ID, { type: 'subscription', id: SUB_ID })]);
    const oldName = 'member 日本 01';
    mocks.listProxyGroups.mockResolvedValue([{ id: DIRECT_PROFILE_ID, name: 'Fallback', kind: 'raw', type: 'select', rank: 0, updated_at: 1,
      'include-all-proxies': true, filter: '^新加坡$', ...(inherited ? { template_id: COLLECTION_ID } : { 'empty-fallback': oldName }) }]);
    if (inherited) mocks.listProxyGroupTemplates.mockResolvedValue([{ id: COLLECTION_ID, name: 'Inherited', 'empty-fallback': oldName }]);
    const next: Subscription = { ...subscription, operators: subscription.operators.map((row) => row.kind === 'rename-template' ? { ...row, template: '${region}' } : row) };
    const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
    await expect(preflightProfileConfig(DIRECT_PROFILE_ID, () => ({ subscriptions: [next] }), context)).rejects.toThrow('empty-fallback is invalid');
    const candidate = await context.analyze(next, { id: 'test', title: 'Test', template: '${region}' });
    expect(candidate.references).toContainEqual({ profileId: DIRECT_PROFILE_ID, kind: 'fallback', owner: DIRECT_PROFILE_ID,
      before: oldName, after: '日本', blocked: false });
    expect(candidate.groups[0].migration).toBeUndefined();
    const changes = context.changesFor(candidate)[0];
    expect(changes.groups[0].after['empty-fallback']).toBe('日本');
    expect(changes.groups[0].after.filter).toBe('^新加坡$');
    await expect(preflightProfileConfig(DIRECT_PROFILE_ID, (state) => ({ subscriptions: [next],
      proxyGroups: state.proxyGroups.map((g) => changes.groups.find((patch) => patch.before.id === g.id)?.after ?? g),
    }), context)).resolves.toMatchObject({ configVersion: 7 });
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
  });

  it.each([false, true])('never blocks on a parked rule and rewrites it only when unique (drop: %s)', async (drop) => {
    const { subscription } = await aggregateFixture();
    mocks.getBase.mockResolvedValue({ content: 'proxies: []\nrules: ["MATCH,DIRECT"]\n# === RULES ===\n', etag: 'base', updated_at: 1 });
    mocks.listProfiles.mockResolvedValue([profile(DIRECT_PROFILE_ID, { type: 'subscription', id: SUB_ID })]);
    mocks.listRules.mockResolvedValue([{ id: DIRECT_PROFILE_ID, type: 'DOMAIN', value: 'parked.example', anchor: 'RULES', policy: 'member 日本 01',
      enabled: false, source: 'manual', rank: 0, added_at: 1, updated_at: 1, revision: 1 }]);
    const next: Subscription = { ...subscription, operators: subscription.operators.map((row) => row.kind === 'rename-template' ? { ...row, template: '${region}' } : row) };
    if (drop) next.operators.push({ id: 'drop', kind: 'filter-regex', mode: 'keep', pattern: '^never-match$' });
    const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
    const candidate = await context.analyze(next, { id: 'test', title: 'Test', template: '${region}' });
    expect(candidate.blocked).toBe(false);
    const changes = context.changesFor(candidate);
    if (drop) expect(changes).toEqual([]);
    else expect(changes[0].rules[0].after).toMatchObject({ enabled: false, policy: '日本', revision: 8 });
    await expect(preflightProfileConfig(DIRECT_PROFILE_ID, (state) => ({ subscriptions: [next],
      rules: state.rules.map((r) => changes[0]?.rules.find((patch) => patch.before.id === r.id)?.after ?? r),
    }), context)).resolves.toMatchObject({ configVersion: 7 });
  });

  it('recommends from all consumers with template inheritance and a single zero-write upstream snapshot', async () => {
    const { raw, subscription } = await aggregateFixture();
    const remote = { ...subscription, kind: 'remote', url: 'https://upstream.example/sub', content: undefined } as Subscription;
    mocks.listSubscriptions.mockResolvedValue([remote]);
    mocks.listProxyGroups.mockImplementation(async (profileId: string) => [{
      id: profileId, name: '地区线路', kind: 'raw', type: 'select', rank: 0, updated_at: 1,
      template_id: COLLECTION_ID, filter: profileId === DIRECT_PROFILE_ID ? '^member 日本 ' : '家宽',
    }]);
    mocks.listProxyGroupTemplates.mockResolvedValue([{ id: COLLECTION_ID, name: 'inherited', updated_at: 1,
      'include-all-proxies': true, 'exclude-type': 'Direct', 'exclude-filter': 'do-not-match' }]);
    const fetcher = vi.fn(async () => new Response(stringify({ proxies: [raw] })));
    vi.stubGlobal('fetch', fetcher);
    try {
      const context = await loadNamingCandidateContext('subscription', SUB_ID, 7);
      const candidates = await context.recommend();
      expect(candidates).toHaveLength(3);
      for (const candidate of candidates) {
        expect(candidate.blocked).toBe(false);
        expect(candidate.sample[0]).toContain('家宽');
        expect(candidate.groups).toHaveLength(2);
        const direct = candidate.groups.find((g) => g.profileId === DIRECT_PROFILE_ID)!;
        expect([direct.before, direct.after, direct.migration?.after]).toEqual([1, 0, 1]);
        const collection = candidate.groups.find((g) => g.profileId === COLLECTION_PROFILE_ID)!;
        expect([collection.before, collection.after]).toEqual([1, 1]);
        expect(context.changesFor(candidate).map((p) => p.profileId)).toEqual([DIRECT_PROFILE_ID]);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mocks.getFetchCache).toHaveBeenCalledTimes(1);
      expect(mocks.setFetchCache).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
