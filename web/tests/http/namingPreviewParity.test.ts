/**
 * Route-level identity/name parity for the PUBLIC preview routes (pass-1
 * finding): POST /api/v1/subscriptions/[id]/preview and POST
 * /api/v1/collections/[id]/preview must run the SAME provenance-aware global
 * fingerprint/name dedup state machine as render, single-subscription export
 * and collection export — after their operator pipelines. The exact
 * [fp1/N, fp2/N, fp2/M] repro must yield the SAME two identities ([N, N ·
 * source-label]) in subscription preview, collection preview, single export
 * and collection export; no public preview may return N,N,M while export
 * returns two nodes. An unrelated managed third member must not change a
 * plain/plain collision, distinct identities sharing a rendered name survive
 * through deterministic suffixing, and previews stay zero-write with bounded
 * privacy-safe diagnostics. (Render ↔ export equality is separately proven
 * by the CROSS-PATH matrix in tests/engine/resolve.test.ts.)
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { withRawIdentity } from '@/lib/proxies/naming';
import {
  exportCollectionNodes,
  exportSubscriptionNodes,
  type NodeExportResult,
} from '@/lib/services/nodeExportService';
import type { Collection, Subscription } from '@/schemas';

/* ─── shared store + fetcher fixtures ───────────────────────────────── */

const stores = new Map<string, Map<string, unknown>>();
function bucket(key: string): Map<string, unknown> {
  let m = stores.get(key);
  if (!m) {
    m = new Map();
    stores.set(key, m);
  }
  return m;
}

const fakeRedis = {
  hgetall: async (key: string) => {
    const m = bucket(key);
    return m.size === 0 ? null : Object.fromEntries(m);
  },
  hget: async (key: string, id: string) => bucket(key).get(id) ?? null,
  hset: async (key: string, payload: Record<string, unknown>) => {
    for (const [id, v] of Object.entries(payload)) bucket(key).set(id, v);
  },
  hdel: async (key: string, ...ids: string[]) => {
    const m = bucket(key);
    if (!m) return 0;
    let n = 0;
    for (const id of ids) if (m.delete(id)) n++;
    return n;
  },
  get: async () => null,
  incr: async (key: string) => {
    const next = ((stores.get(key)?.get('__v') as number | undefined) ?? 0) + 1;
    bucket(key).set('__v', next);
    return next;
  },
  eval: async () => [1, '1'],
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: () => tx,
      incr: () => tx,
      exec: async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out;
      },
    };
    return tx;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/nodeOrdinalService', () => ({
  resolveOrdinalsFor: vi.fn(async () => () => undefined),
  createOrdinalDomainRegistry: vi.fn(() => ({
    registerSourceDomain: vi.fn(),
    fingerprintsForSource: vi.fn(() => undefined),
  })),
  createOrdinalPlanningSession: vi.fn(async () => ({
    registerSourceDomain: vi.fn(),
    fingerprintsForSource: vi.fn(() => undefined),
    resolverFor: vi.fn(() => () => undefined),
    seal: vi.fn(() => ({ expectedGeneration: 0, expectedGlobalSize: 0, sources: [] })),
  })),
}));

/**
 * The fetcher is the single seam both routes AND both exports share: the
 * mock returns the SAME raw nodes per subscription to resolveSubscription-
 * ProxiesRaw (preview) and resolveSubscriptionProxies (export). The preview
 * route attaches the raw-identity envelope; the export computes the same
 * fingerprint (name-excluded) — byte-identical identity either way.
 */
const rawBySub = new Map<string, Record<string, unknown>[]>();
const fetchCalls: Array<{ fn: string; sub: string; writeCache: boolean | undefined }> = [];
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxiesRaw: vi.fn(async (sub: Subscription) => {
    fetchCalls.push({ fn: 'raw', sub: sub.id, writeCache: undefined });
    return { proxies: rawBySub.get(sub.id) ?? [], proxyCount: rawBySub.get(sub.id)?.length ?? 0 };
  }),
  // The EXPORT path mirrors production resolveSubscriptionProxies: attach
  // the raw identity AND run the member's own saved operator pipeline, so
  // export and preview operate on byte-identical inputs and steps.
  resolveSubscriptionProxies: vi.fn(async (sub: Subscription) => {
    fetchCalls.push({ fn: 'resolved', sub: sub.id, writeCache: undefined });
    const identity = { key: sub.name, label: sub.display_name?.trim() || sub.name };
    const raw = (rawBySub.get(sub.id) ?? []).map((p) => withRawIdentity(p, identity));
    const { isExecutableOperator } = await import('@/schemas/operator');
    const { applyOperators } = await import('@/lib/proxies/operators');
    const executable = (sub.operators ?? []).filter(isExecutableOperator);
    const { proxies } = applyOperators(raw as never, executable, () => undefined);
    return { proxies, proxyCount: proxies.length };
  }),
}));
vi.mock('@/lib/services/nodeReferenceService', () => ({
  findNodeReferences: vi.fn(async () => []),
}));

import { POST as subPreviewPOST } from '@/app/api/v1/subscriptions/[id]/preview/route';
import { POST as collectionPreviewPOST } from '@/app/api/v1/collections/[id]/preview/route';
import { POST as namingPOST } from '@/app/api/v1/naming/[type]/[id]/route';
import { namingCandidateForEntity } from '@/lib/services/namingPreviewService';
import { getSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { getCollection } from '@/lib/services/collectionService';

const SUB_A = '11111111-1111-4111-8111-111111111111';
const SUB_B = '22222222-2222-4222-8222-222222222222';
const SUB_C = '33333333-3333-4333-8333-333333333333';
const COL = '44444444-4444-4444-8444-444444444444';

const node = (name: string, server: string, port = 8388) => ({
  name,
  type: 'ss',
  server,
  port,
  cipher: 'aes-128-gcm',
  password: 'p',
});

function makeSub(over: Partial<Subscription> & { id: string; name: string }): Subscription {
  return {
    id: over.id,
    name: over.name,
    display_name: over.display_name,
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 600_000,
    tags: [],
    operators: over.operators ?? [],
    updated_at: 1,
  };
}

const RENAME_OP = {
  id: 'rt-1',
  kind: 'rename-template' as const,
  template: '${emoji} ${region}',
  recognitionRules: [] as Array<{
    pattern: string;
    field: 'region' | 'route' | 'vendor' | 'entry';
    value: string;
  }>,
};

function seed(): void {
  stores.clear();
  rawBySub.clear();
  fetchCalls.length = 0;
  // managed member 甲: fp1/N
  bucket(REDIS_KEYS.subscriptions).set(
    SUB_A,
    makeSub({ id: SUB_A, name: 'member-a', display_name: '成员甲', operators: [RENAME_OP] }),
  );
  // plain member 乙: fp2/N + fp2/M
  bucket(REDIS_KEYS.subscriptions).set(
    SUB_B,
    makeSub({ id: SUB_B, name: 'member-b', display_name: '成员乙' }),
  );
  // unrelated managed member 丙: fp3/X
  bucket(REDIS_KEYS.subscriptions).set(
    SUB_C,
    makeSub({ id: SUB_C, name: 'member-c', display_name: '成员丙', operators: [RENAME_OP] }),
  );
  bucket(REDIS_KEYS.collections).set(COL, {
    id: COL,
    name: '聚合甲',
    slug: 'agg-a',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    operators: [],
    updated_at: 1,
  });
  rawBySub.set(SUB_A, [node('N', 'fp1.example')]);
  rawBySub.set(SUB_B, [node('N', 'fp2.example'), node('M', 'fp2.example')]);
  rawBySub.set(SUB_C, [node('X', 'fp3.example')]);
}

beforeAll(() => {
  installTestHandleSecret();
});

beforeEach(() => {
  seed();
});

/* ─── helpers ───────────────────────────────────────────────────────── */

async function subPreview(
  id: string,
  operators: unknown[],
): Promise<{
  after: { count: number; names: string[] };
  issues: unknown[];
  status: number;
  steps: Array<{ deduped?: Array<{ sourceKey?: string }> }>;
}> {
  const res = await subPreviewPOST(
    new Request(`http://localhost/api/v1/subscriptions/${id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operators }),
    }),
    { params: Promise.resolve({ id }) } as never,
  );
  const body = (await res.json()) as {
    data: { after: { count: number; names: string[] }; issues: unknown[]; steps: unknown[] };
  };
  return {
    after: body.data.after,
    issues: body.data.issues,
    status: res.status,
    steps: body.data.steps as Array<{ deduped?: Array<{ sourceKey?: string }> }>,
  };
}

async function collectionPreview(
  id: string,
  operators: unknown[],
): Promise<{ after: { count: number; names: string[] }; issues: unknown[]; status: number }> {
  const res = await collectionPreviewPOST(
    new Request(`http://localhost/api/v1/collections/${id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operators }),
    }),
    { params: Promise.resolve({ id }) } as never,
  );
  const body = (await res.json()) as {
    data: { after: { count: number; names: string[] }; issues: unknown[] };
  };
  return { after: body.data.after, issues: body.data.issues, status: res.status };
}

function namesOf(exportResult: NodeExportResult): string[] {
  return exportResult.proxies.map((p) => String(p.name));
}

/** Update the collection's member list in the store and return the FRESH
 * entity (repos read per call — the stale object must never be used). */
async function setCollectionMembers(ids: string[]): Promise<Collection> {
  const collection = await getCollection(COL);
  if (!collection) throw new Error('collection missing');
  const next = { ...collection, subscription_ids: ids };
  bucket(REDIS_KEYS.collections).set(COL, next);
  const fresh = await getCollection(COL);
  if (!fresh) throw new Error('collection missing after update');
  return fresh;
}

/* ─── exact repro: fp1/N, fp2/N, fp2/M ─────────────────────────────── */

describe('route-level preview vs export parity (pass-1 finding)', () => {
  it('SUBSCRIPTION preview == single export: [fp1/N, fp2/N, fp2/M] managed → [N, N · label]', async () => {
    rawBySub.set(SUB_A, [
      node('N', 'fp1.example'),
      node('N', 'fp2.example'),
      node('M', 'fp2.example'),
    ]);
    const sub = await getSubscription(SUB_A);
    const exportResult = await exportSubscriptionNodes(sub!, { writeCache: false });
    expect(exportResult.proxyCount).toBe(2);

    // the preview posts the SAME candidate pipeline as the saved plan
    const preview = await subPreview(SUB_A, [RENAME_OP]);
    expect(preview.status).toBe(200);
    expect(preview.after.names).toEqual(namesOf(exportResult));
    expect(preview.after.count).toBe(2);
    // the suffix-renamed keeper + the true duplicate dropped: N and a
    // deterministic N · label suffix (the executor's own disambiguation
    // format for a single managed source — byte-identical across paths)
    expect(preview.after.names[0]).toBe('N');
    expect(preview.after.names[1]).toMatch(/^N · /);
    // NO public preview may return N,N,M
    expect(preview.after.names).not.toEqual(['N', 'N', 'M']);
  });

  it('SUBSCRIPTION preview == single export: plain/plain [fp1/N, fp2/N, fp2/M] → [N]', async () => {
    // plain sub: same-name same-format collision keeps the FIRST identity
    // only; the fp2 duplicate is dropped by identity — the export contract
    const sub = await getSubscription(SUB_B);
    const exportResult = await exportSubscriptionNodes(sub!, { writeCache: false });
    expect(exportResult.proxyCount).toBe(1);

    const preview = await subPreview(SUB_B, []);
    expect(preview.status).toBe(200);
    expect(preview.after.names).toEqual(namesOf(exportResult));
    expect(preview.after.names).toEqual(['N']);
  });

  it('COLLECTION preview == collection export: [fp1/N, fp2/N, fp2/M] → [N, N · 成员乙]', async () => {
    // member-a is managed by its own rename op; member-b is plain; the
    // collection itself has NO operators — per-node provenance decides
    const collection = await setCollectionMembers([SUB_A, SUB_B]);
    const subs = await listSubscriptions();
    const exportResult = await exportCollectionNodes(collection, subs, { writeCache: false });
    expect(exportResult.proxyCount).toBe(2);
    expect(namesOf(exportResult)).toEqual(['N', 'N · 成员乙']);

    const preview = await collectionPreview(COL, []);
    expect(preview.status).toBe(200);
    expect(preview.after.names).toEqual(namesOf(exportResult));
    expect(preview.after.names).toEqual(['N', 'N · 成员乙']);
  });

  it('NAMING workspace preview == generic collection preview for the same managed candidate (REAL dedup authority)', async () => {
    // member-a managed (fp1/N), member-b plain (fp2/N + fp2/M) — the
    // collection itself has no operators; the naming preview builds a
    // managed candidate over the collection (absent → naming-plan) and must
    // run the SAME provenance-aware dedup state machine as the generic
    // collection preview with byte-identical candidate operators
    await setCollectionMembers([SUB_A, SUB_B]);
    // the naming route authorizes through the caller's default profile
    bucket(REDIS_KEYS.profiles).set('99999999-9999-4999-8999-999999999999', {
      id: '99999999-9999-4999-8999-999999999999',
      name: 'default',
      source: { type: 'collection', id: COL },
      updated_at: 1,
    });

    const plan = {
      template: '${emoji} ${region}${?source: · ${source}}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    };
    const namingRes = await namingPOST(
      new Request(`http://localhost/api/v1/naming/collection/${COL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: plan }),
      }),
      { params: Promise.resolve({ type: 'collection', id: COL }) } as never,
    );
    expect(namingRes.status).toBe(200);
    const namingBody = (await namingRes.json()) as {
      data: {
        after: { count: number; names: string[] };
        candidate: { id: string; index: number; mode: string };
      };
    };
    expect(namingBody.data.candidate).toEqual({ id: 'naming-plan', index: 0, mode: 'added' });

    // the generic collection preview posts the SAME candidate operators the
    // naming route derived (shared builder) — outputs must be identical
    const fresh = await getCollection(COL);
    if (!fresh) throw new Error('collection missing');
    const candidate = namingCandidateForEntity(fresh, plan);
    const generic = await collectionPreview(COL, candidate.operators);
    expect(generic.status).toBe(200);
    expect(generic.after).toEqual(namingBody.data.after);
    // the REAL dedup machine collapses the fp2 duplicate and the
    // collection-level managed candidate renames every node by its source
    // alias — the EXACT managed-resolution names (with a `false` predicate
    // the machine would return ['N', 'M'], so this assertion is
    // predicate-sensitive)
    expect(namingBody.data.after.names).toEqual(['成员甲', '成员乙']);
  });

  it('an unrelated MANAGED third member never changes a plain/plain collision', async () => {
    // plain-a(X), plain-b(N), managed-c(X2) — the collection has no ops
    bucket(REDIS_KEYS.subscriptions).set(
      '55555555-5555-4555-8555-555555555555',
      makeSub({
        id: '55555555-5555-4555-8555-555555555555',
        name: 'plain-a',
        display_name: '甲',
      }),
    );
    rawBySub.set('55555555-5555-4555-8555-555555555555', [node('X', 'x.example')]);
    bucket(REDIS_KEYS.subscriptions).set(
      '66666666-6666-4666-8666-666666666666',
      makeSub({
        id: '66666666-6666-4666-8666-666666666666',
        name: 'plain-b',
        display_name: '乙',
      }),
    );
    rawBySub.set('66666666-6666-4666-8666-666666666666', [node('N', 'n.example')]);
    rawBySub.set(SUB_C, [node('X', 'x2.example')]); // managed 丙: same name X, different node
    const collection = await setCollectionMembers([
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      SUB_C,
    ]);
    const subs = await listSubscriptions();
    const exportResult = await exportCollectionNodes(collection, subs, { writeCache: false });
    // plain-a keeps X; plain-b's N is untouched (plain/plain first-writer);
    // managed 丙's X2 collides with plain-a's X by NAME only — distinct
    // identity, managed path → deterministic suffix, never a promotion of
    // the plain/plain pair
    expect(exportResult.proxyCount).toBe(3);
    expect(namesOf(exportResult)).toEqual(['X', 'N', 'X · 成员丙']);

    const preview = await collectionPreview(COL, []);
    expect(preview.status).toBe(200);
    expect(preview.after.names).toEqual(namesOf(exportResult));
    expect(preview.after.names).toEqual(['X', 'N', 'X · 成员丙']);
  });

  it('distinct identities sharing a rendered name survive through deterministic suffixing', async () => {
    // managed member 甲 contributes fp1/N, PLAIN member 乙 contributes fp2/N
    // — distinct identities, same rendered name: the later one must SURVIVE
    // with the deterministic N · source-label suffix (per-node managed
    // provenance), never first-writer-wins drop
    const collection = await setCollectionMembers([SUB_A, SUB_B]);
    const subs = await listSubscriptions();
    const exportResult = await exportCollectionNodes(collection, subs, { writeCache: false });
    expect(exportResult.proxyCount).toBe(2);
    expect(namesOf(exportResult)).toEqual(['N', 'N · 成员乙']);

    const preview = await collectionPreview(COL, []);
    expect(preview.status).toBe(200);
    expect(preview.after.names).toEqual(namesOf(exportResult));
  });

  it('preview diagnostics are bounded and privacy-safe; previews stay zero-write', async () => {
    // 5000 identical identities → the dedup diagnostics must be capped,
    // scrubbed, and never carry server names/URLs/credentials
    const many: Record<string, unknown>[] = [];
    for (let i = 0; i < 5000; i += 1) many.push(node('香港 01', `s${i}.evil.example`, 8388));
    rawBySub.set(SUB_B, many);
    bucket(REDIS_KEYS.subscriptions).set(
      SUB_B,
      makeSub({ id: SUB_B, name: 'member-b', display_name: '成员乙' }),
    );
    const preview = await subPreview(SUB_B, []);
    expect(preview.status).toBe(200);
    expect(preview.after.count).toBe(1);
    expect(preview.after.names).toEqual(['香港 01']);
    const serialized = JSON.stringify(preview);
    // scrubbed + bounded: no server hosts, no URLs, no ports as fields
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('http');
    expect(preview.issues.length).toBeLessThanOrEqual(60);
    expect(preview.after.names.length).toBeLessThanOrEqual(300);
    // preview is read-only: NOTHING was written to any store
    for (const key of [...stores.keys()]) {
      expect(key.startsWith('config:') || key === REDIS_KEYS.namingHistory).toBe(false);
    }
    expect([...stores.keys()].some((k) => k.startsWith('fetch-cache:'))).toBe(false);
    expect(fetchCalls.every((c) => c.fn === 'raw' || c.fn === 'resolved')).toBe(true);
  });

  describe('pass-2 second-order suffix/literal collision (fp1/N managed, fp2/N plain, fp3/"N · B" plain)', () => {
    /** The plain member carries fp2/N AND the literal "N · B" that the machine
     * generates as fp2's suffix — the exact Delivery probe fixture. */
    function seedSecondOrderFixture(): void {
      rawBySub.set(SUB_A, [node('N', 'fp1.example')]);
      // the literal equals the EXACT suffix the machine generates for fp2/N
      // (member label 成员乙) — the pass-2 second-order collision
      rawBySub.set(SUB_B, [node('N', 'fp2.example'), node('N · 成员乙', 'fp3.example')]);
    }

    it('the SHARED machine reserves every emitted final: [N, N · B, N · B · B] with unique names', async () => {
      const { dedupByNameAndIdentity } = await import('@/lib/proxies/nodeDedup');
      const result = dedupByNameAndIdentity([
        { name: 'N', fp: 'fp1', sourceKey: 'a', sourceLabel: 'A', managed: true },
        { name: 'N', fp: 'fp2', sourceKey: 'b', sourceLabel: 'B', managed: false },
        { name: 'N · B', fp: 'fp3', sourceKey: 'b', sourceLabel: 'B', managed: false },
      ]);
      const names = result.kept.map((k) => k.finalName);
      expect(names).toEqual(['N', 'N · B', 'N · B · B']);
      expect(new Set(names).size).toBe(3);
      // fingerprint registration retained: a later true duplicate of the
      // suffixed keeper (fp2/M) is still deduped globally
      const second = dedupByNameAndIdentity([
        { name: 'N', fp: 'fp1', sourceKey: 'a', sourceLabel: 'A', managed: true },
        { name: 'N', fp: 'fp2', sourceKey: 'b', sourceLabel: 'B', managed: false },
        { name: 'N · B', fp: 'fp3', sourceKey: 'b', sourceLabel: 'B', managed: false },
        { name: 'M', fp: 'fp2', sourceKey: 'b', sourceLabel: 'B', managed: false },
      ]);
      expect(second.kept.map((k) => k.finalName)).toEqual(['N', 'N · B', 'N · B · B']);
      // and a later literal equal to a generated suffix gets suffixed again,
      // never silently duplicating
      const third = dedupByNameAndIdentity([
        { name: 'N', fp: 'fp1', sourceKey: 'a', sourceLabel: 'A', managed: true },
        { name: 'N', fp: 'fp2', sourceKey: 'b', sourceLabel: 'B', managed: false },
        { name: 'N · B', fp: 'fp3', sourceKey: 'b', sourceLabel: 'B', managed: false },
        { name: 'N · B', fp: 'fp4', sourceKey: 'b', sourceLabel: 'B', managed: false },
      ]);
      const names3 = third.kept.map((k) => k.finalName);
      expect(names3[0]).toBe('N');
      expect(new Set(names3).size).toBe(names3.length);
    });

    it('COLLECTION preview == collection export: managed fp1/N + plain [fp2/N, fp3/N · B] → [N, N · B, N · B · B]', async () => {
      seedSecondOrderFixture();
      const collection = await setCollectionMembers([SUB_A, SUB_B]);
      const subs = await listSubscriptions();
      const exportResult = await exportCollectionNodes(collection, subs, { writeCache: false });
      expect(exportResult.proxyCount).toBe(3);
      expect(namesOf(exportResult)).toEqual(['N', 'N · 成员乙', 'N · 成员乙 · 成员乙']);

      const preview = await collectionPreview(COL, []);
      expect(preview.status).toBe(200);
      expect(preview.after.names).toEqual(namesOf(exportResult));
      expect(new Set(preview.after.names).size).toBe(preview.after.names.length);
    });

    it('RENDER (collection-bound) keeps the same three unique identities', async () => {
      const { resolveConfig } = await import('@/lib/engine/resolve');
      seedSecondOrderFixture();
      const collection = await setCollectionMembers([SUB_A, SUB_B]);
      const subs = await listSubscriptions();
      const render = await resolveConfig(
        'mixed-port: 7890\nproxies: []\nproxy-groups: []\nrules: []\n',
        [],
        subs,
        [],
        [],
        { collections: [collection], boundSource: { type: 'collection', id: COL } },
      );
      const renderNames = [...render.nodeNames].sort();
      expect(renderNames).toEqual(['N', 'N · 成员乙', 'N · 成员乙 · 成员乙'].sort());
    });

    it('member SINGLE exports keep their own identities; SUBSCRIPTION preview == single export with unique names', async () => {
      seedSecondOrderFixture();
      const managedA = await getSubscription(SUB_A);
      const a = await exportSubscriptionNodes(managedA!, { writeCache: false });
      expect(a.proxies.map((p) => String(p.name))).toEqual(['N']);
      const plainB = await getSubscription(SUB_B);
      const b = await exportSubscriptionNodes(plainB!, { writeCache: false });
      // plain sub: fp2/N kept, fp3/"N · B" kept (distinct names) — no
      // generated suffix exists inside a single plain source
      const bNames = b.proxies.map((p) => String(p.name));
      expect(bNames).toEqual(['N', 'N · 成员乙']);
      expect(new Set(bNames).size).toBe(2);

      // SUBSCRIPTION preview parity with the single export on the same fixture
      const preview = await subPreview(SUB_B, []);
      expect(preview.status).toBe(200);
      expect(preview.after.names).toEqual(bNames);
      expect(new Set(preview.after.names).size).toBe(preview.after.names.length);

      // managed single-sub: the EXECUTOR generates its own suffix; a literal
      // equal to the executor's generated final is itself suffixed — preview
      // must equal export byte-for-byte and stay unique
      rawBySub.set(SUB_A, [
        node('香港 01', 'fp1.example'),
        node('香港 01', 'fp2.example'),
        node('香港 01 #2', 'fp3.example'),
      ]);
      const managedSub = await getSubscription(SUB_A);
      const a2 = await exportSubscriptionNodes(managedSub!, { writeCache: false });
      const a2Names = a2.proxies.map((p) => String(p.name));
      expect(new Set(a2Names).size).toBe(a2Names.length);
      const preview2 = await subPreview(SUB_A, [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ]);
      expect(preview2.after.names).toEqual(a2Names);
      // pass-7 blocker 1: rename-template dedup provenance in the preview
      // steps projects as KEYED src handles — the stable source key never
      // reaches the browser/model surface
      const serialized = JSON.stringify(preview2.steps);
      expect(serialized).not.toContain('airport-a');
      for (const step of preview2.steps) {
        for (const d of step.deduped ?? []) {
          if (d.sourceKey !== undefined) {
            expect(d.sourceKey).toMatch(/^src-[0-9a-f]{16}$/);
          }
        }
      }
    });
  });
});
