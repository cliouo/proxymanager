import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsError } from '@/lib/http/problem';
import { REDIS_KEYS } from '@/lib/redis/keys';

/**
 * renderProfileConfig — cache-validity matrix. resolveConfig and every repo
 * are mocked; what's under test is purely the read-short-circuit logic:
 * hit / version-mismatch / freshness-expiry / providerUrlBase-mismatch /
 * noCache-bypass, plus the version-before-data race guard.
 */

// ---- fake redis (mget is the hot path) -------------------------------------

const kv = new Map<string, unknown>();
const counters = new Map<string, number>();
let beforeRepairEval: (() => Promise<void>) | null = null;

function readKey(key: string): unknown {
  if (counters.has(key)) return counters.get(key);
  return kv.get(key) ?? null;
}

const setCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];
const evalCalls: Array<{ script: string; keys: string[]; args: string[] }> = [];

const fakeRedis = {
  mget: async (...keys: string[]) => keys.map(readKey),
  get: async (key: string) => readKey(key),
  set: async (key: string, value: unknown, opts?: unknown) => {
    kv.set(key, value);
    if (key !== REDIS_KEYS.configVersion) setCalls.push({ key, value, opts });
  },
  del: async (key: string) => {
    const removed = Number(kv.delete(key) || counters.delete(key));
    return removed;
  },
  eval: async (script: string, keys: string[], args: string[]) => {
    evalCalls.push({ script, keys, args });
    if (beforeRepairEval) await beforeRepairEval();
    const key = keys[0];
    const current = readKey(key);
    const raw = typeof current === 'number' || typeof current === 'string' ? String(current) : '';
    const canonical = raw === '0' || /^[1-9]\d*$/.test(raw);
    const parsed = canonical ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      counters.delete(key);
      kv.set(key, Number(args[0]));
      return 1;
    }
    return 0;
  },
  incr: async (key: string) => {
    const current = readKey(key);
    if (current !== null && (typeof current !== 'number' || !Number.isSafeInteger(current))) {
      throw new Error('value is not an integer');
    }
    const next = (current ?? 0) + 1;
    kv.delete(key);
    counters.set(key, next);
    return next;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

// ---- mocked pipeline + repos ------------------------------------------------

const RESOLVED_CONTENT = 'proxies: []\n';
const RESOLVED_BUILD_ID = createHash('sha256')
  .update(RESOLVED_CONTENT, 'utf8')
  .digest('hex')
  .slice(0, 8);
const RESOLVED = {
  content: RESOLVED_CONTENT,
  buildId: RESOLVED_BUILD_ID,
  anchorsApplied: [],
  unmatchedAnchors: [],
  ruleProvidersApplied: [],
  subscriptions: [{ name: 'airport-a', injectedCount: 3 }],
  collisions: [],
  nodeNames: ['n1', 'n2', 'n3'],
  nodesBySub: {},
  warnings: [],
  inlinedProxyCount: 3,
  proxyGroupCount: 0,
};

const resolveConfigMock = vi.fn(async (...args: unknown[]) => {
  void args;
  return { ...RESOLVED };
});
vi.mock('@/lib/engine/resolve', () => ({
  resolveConfig: (...args: unknown[]) => resolveConfigMock(...args),
}));

const BASE = {
  content: 'proxies: []\n# === PROXY-GROUPS ===\n',
  anchors: [],
  policies: [],
  etag: 'etag-1',
  updated_at: 1_700_000_000,
};
const getBaseMock = vi.fn(async (): Promise<typeof BASE | null> => BASE);
vi.mock('@/lib/repos/baseRepo', () => ({ getBase: () => getBaseMock() }));

// Two subs in the library; only airport-a participates per RESOLVED.subscriptions.
const SUBS = [
  {
    id: 's1',
    name: 'airport-a',
    enabled: true,
    kind: 'remote',
    ttl_ms: 600_000,
    tags: [],
    operators: [],
  },
  {
    id: 's2',
    name: 'airport-b',
    enabled: true,
    kind: 'remote',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
  },
];
vi.mock('@/lib/repos/subscriptionsRepo', () => ({ listSubscriptions: async () => SUBS }));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: async () => [] }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: async () => [] }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({ listProxyGroups: async () => [] }));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({ listProxyGroupTemplates: async () => [] }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: async () => [] }));
// Per-profile (Phase 2): the engine resolves the profile record by name, then
// loads base/rules/proxy-groups under its id. `default` resolves to a record;
// any other name resolves to null (→ 404).
const DEFAULT_PROFILE = {
  id: 'prof-default',
  name: 'default',
  source: { type: 'none' as const },
  updated_at: 0,
};
const SECOND_PROFILE = {
  id: 'prof-secondary',
  name: 'secondary',
  source: { type: 'none' as const },
  updated_at: 0,
};
vi.mock('@/lib/repos/profilesRepo', () => ({
  getProfileByName: async (name: string) => {
    if (name === 'default') return DEFAULT_PROFILE;
    if (name === 'secondary') return SECOND_PROFILE;
    return null;
  },
}));

let mod: typeof import('@/lib/engine/renderCache');

beforeEach(async () => {
  kv.clear();
  counters.clear();
  setCalls.length = 0;
  evalCalls.length = 0;
  beforeRepairEval = null;
  resolveConfigMock.mockClear();
  getBaseMock.mockClear();
  getBaseMock.mockImplementation(async () => BASE);
  vi.restoreAllMocks();
  mod = await import('@/lib/engine/renderCache');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const URL_BASE = 'https://pm.example/api/rule-providers/tok';

describe('renderProfileConfig — miss then hit', () => {
  it('renders on cold cache (miss) and writes the entry with min participating ttl_ms', async () => {
    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.cache).toBe('miss');
    expect(out.resolved.content).toBe(RESOLVED.content);
    expect(out.baseEtag).toBe('etag-1');
    expect(out.baseUpdatedAt).toBe(1_700_000_000);
    expect(resolveConfigMock).toHaveBeenCalledTimes(1);
    const resolveOptions = resolveConfigMock.mock.calls[0][5] as {
      ignoreFailedSubs?: boolean;
    };
    expect(resolveOptions.ignoreFailedSubs).toBe(false);

    // Entry written under render:{profile} with EX = ceil(freshForMs/1000)+60.
    // airport-b (ttl 60s) did NOT participate, so the window is airport-a's 600s.
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].key).toBe(REDIS_KEYS.renderCache('default'));
    const entry = setCalls[0].value as { freshForMs: number; version: number };
    expect(entry.freshForMs).toBe(600_000);
    expect(entry.version).toBe(0);
    expect(setCalls[0].opts).toEqual({ ex: 600 + 60 });
  });

  it('serves the second read from cache without touching the pipeline', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.cache).toBe('hit');
    expect(out.resolved.buildId).toBe(RESOLVED_BUILD_ID);
    expect(out.baseEtag).toBe('etag-1');
    expect(resolveConfigMock).toHaveBeenCalledTimes(1);
    expect(getBaseMock).toHaveBeenCalledTimes(1); // hit path loads no data
  });

  it('caps freshForMs at 24h when no subscription participates', async () => {
    resolveConfigMock.mockResolvedValueOnce({ ...RESOLVED, subscriptions: [] });
    await mod.renderProfileConfig('default', {});
    const entry = setCalls[0].value as { freshForMs: number };
    expect(entry.freshForMs).toBe(24 * 60 * 60 * 1000);
  });

  it('does not publish a cache entry when the full render fails closed', async () => {
    resolveConfigMock.mockRejectedValueOnce(new Error('PROXY-GROUPS marker is missing'));

    await expect(mod.renderProfileConfig('default', {})).rejects.toThrow(/PROXY-GROUPS/);

    expect(setCalls).toHaveLength(0);
    expect(kv.has(REDIS_KEYS.renderCache('default'))).toBe(false);
  });
});

describe('renderProfileConfig — invalidation paths', () => {
  it('rejects epoch 9 entries created before proxy parsing became fail-closed', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const key = REDIS_KEYS.renderCache('default');
    const entry = kv.get(key) as { epoch: number };
    entry.epoch = 9;

    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.cache).toBe('miss');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
  });

  it('treats a corrupt cache envelope as a miss instead of serving it', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const key = REDIS_KEYS.renderCache('default');
    const entry = kv.get(key) as Record<string, unknown>;
    entry.content = 42;

    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.cache).toBe('miss');
    expect(out.resolved.content).toBe(RESOLVED.content);
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['empty content', (entry: Record<string, unknown>) => (entry.content = '')],
    ['mismatched build id', (entry: Record<string, unknown>) => (entry.buildId = 'deadbeef')],
    [
      'far-future rendered timestamp',
      (entry: Record<string, unknown>) => (entry.renderedAt = Date.now() + 24 * 60 * 60 * 1000),
    ],
    [
      'freshness above the configured maximum',
      (entry: Record<string, unknown>) => (entry.freshForMs = 24 * 60 * 60 * 1000 + 1),
    ],
    [
      'malformed anchor metadata',
      (entry: Record<string, unknown>) => (entry.anchorsApplied = [{ anchor: 'manual' }]),
    ],
    [
      'non-string unmatched anchor',
      (entry: Record<string, unknown>) => (entry.unmatchedAnchors = [42]),
    ],
    [
      'non-string applied rule provider',
      (entry: Record<string, unknown>) => (entry.ruleProvidersApplied = [false]),
    ],
    [
      'malformed subscription metadata',
      (entry: Record<string, unknown>) =>
        (entry.subscriptions = [{ name: 'airport-a', injectedCount: '3' }]),
    ],
    [
      'malformed collision metadata',
      (entry: Record<string, unknown>) =>
        (entry.collisions = [{ name: 'n1', keptFrom: null, droppedFrom: [7] }]),
    ],
    ['non-string node name', (entry: Record<string, unknown>) => (entry.nodeNames = [false])],
    [
      'malformed per-sub node list',
      (entry: Record<string, unknown>) => (entry.nodesBySub = { airport: ['n1', 2] }),
    ],
    ['non-string warning', (entry: Record<string, unknown>) => (entry.warnings = [{}])],
  ])('treats %s as a cache miss', async (_label, corrupt) => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const key = REDIS_KEYS.renderCache('default');
    corrupt(kv.get(key) as Record<string, unknown>);

    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });

    expect(out.cache).toBe('miss');
    expect(out.resolved.content).toBe(RESOLVED.content);
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a present-invalid config version match a legacy version-zero entry', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    kv.set(REDIS_KEYS.configVersion, 'not-a-version');

    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });

    expect(out.cache).toBe('miss');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
    expect(setCalls).toHaveLength(1); // only the initial, pre-corruption write
    expect(kv.has(REDIS_KEYS.renderCache('default'))).toBe(false);
  });

  it('repairs an invalid version to a nonzero global generation before the next read', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const changedContent = 'proxies:\n  - name: CHANGED\n    type: direct\n';
    const changed = {
      ...RESOLVED,
      content: changedContent,
      buildId: createHash('sha256').update(changedContent, 'utf8').digest('hex').slice(0, 8),
    };
    resolveConfigMock.mockResolvedValueOnce(changed).mockResolvedValueOnce(changed);
    kv.set(REDIS_KEYS.configVersion, 'not-a-version');

    const duringCorruption = await mod.renderProfileConfig('default', {
      providerUrlBase: URL_BASE,
    });
    expect(duringCorruption.cache).toBe('miss');
    expect(duringCorruption.resolved.content).toBe(changedContent);
    expect(kv.get(REDIS_KEYS.configVersion)).toEqual(expect.any(Number));
    expect(kv.get(REDIS_KEYS.configVersion)).not.toBe(0);

    const afterRecovery = await mod.renderProfileConfig('default', {
      providerUrlBase: URL_BASE,
    });

    expect(afterRecovery.cache).toBe('miss');
    expect(afterRecovery.resolved.content).toBe(changedContent);
    expect(resolveConfigMock).toHaveBeenCalledTimes(3);
  });

  it('invalidating one profile repairs the global generation for every other profile', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    await mod.renderProfileConfig('secondary', { providerUrlBase: URL_BASE });
    kv.set(REDIS_KEYS.configVersion, 'not-a-version');

    const detected = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(detected.cache).toBe('miss');

    // `secondary` was never requested while the key was corrupt, so its old v0
    // entry still exists. The repaired global generation must nevertheless
    // force a miss instead of resurrecting it.
    const otherProfile = await mod.renderProfileConfig('secondary', {
      providerUrlBase: URL_BASE,
    });

    expect(otherProfile.cache).toBe('miss');
    expect(resolveConfigMock).toHaveBeenCalledTimes(4);
  });

  it.each(['00', '01'])(
    'repairs non-canonical Redis integer %s before another profile can reuse v0',
    async (rawVersion) => {
      await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
      await mod.renderProfileConfig('secondary', { providerUrlBase: URL_BASE });
      kv.set(REDIS_KEYS.configVersion, rawVersion);

      const detected = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
      expect(detected.cache).toBe('miss');
      expect(kv.get(REDIS_KEYS.configVersion)).toEqual(expect.any(Number));
      expect(evalCalls.at(-1)?.script).toContain("current == '0'");
      expect(evalCalls.at(-1)?.script).toContain("'^[1-9]%d*$'");

      const otherProfile = await mod.renderProfileConfig('secondary', {
        providerUrlBase: URL_BASE,
      });
      expect(otherProfile.cache).toBe('miss');
      expect(resolveConfigMock).toHaveBeenCalledTimes(4);
    },
  );

  it('a delayed repair CAS never overwrites a concurrent valid INCR generation', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    await mod.renderProfileConfig('secondary', { providerUrlBase: URL_BASE });
    kv.set(REDIS_KEYS.configVersion, 'not-a-version');

    let signalEntered: (() => void) | undefined;
    let releaseRepair: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    beforeRepairEval = async () => {
      signalEntered?.();
      await held;
    };

    const repairing = mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    await entered;

    // Another actor repairs the key, then a normal repo write advances it.
    // The delayed Lua repair must observe 101 and leave it untouched.
    kv.set(REDIS_KEYS.configVersion, 100);
    await fakeRedis.incr(REDIS_KEYS.configVersion);
    releaseRepair?.();
    await repairing;

    expect(readKey(REDIS_KEYS.configVersion)).toBe(101);
    const otherProfile = await mod.renderProfileConfig('secondary', {
      providerUrlBase: URL_BASE,
    });
    expect(otherProfile.cache).toBe('miss');
    expect(readKey(REDIS_KEYS.configVersion)).toBe(101);
  });

  it('re-renders when config:version was bumped (write invalidation)', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    await fakeRedis.incr(REDIS_KEYS.configVersion); // simulate a repo write
    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.cache).toBe('miss');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
    // The rewritten entry carries the new version → next read hits again.
    const again = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(again.cache).toBe('hit');
  });

  it('re-renders when the entry is older than its freshness window', async () => {
    const t0 = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    // 600s window (airport-a ttl) — jump past it.
    nowSpy.mockReturnValue(t0 + 600_001);
    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.cache).toBe('miss');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
  });

  it('re-renders when providerUrlBase differs (rendered URLs bake it in)', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const out = await mod.renderProfileConfig('default', {
      providerUrlBase: 'https://other.example/api/rule-providers/tok',
    });
    expect(out.cache).toBe('miss');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
  });

  it('treats undefined providerUrlBase as its own identity', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const out = await mod.renderProfileConfig('default', {});
    expect(out.cache).toBe('miss');
  });
});

describe('renderProfileConfig — noCache bypass', () => {
  it('skips the cache read, forwards noCache to resolveConfig, still rewrites the cache', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE }); // prime
    const out = await mod.renderProfileConfig('default', {
      providerUrlBase: URL_BASE,
      noCache: true,
    });
    expect(out.cache).toBe('bypass');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
    const opts = resolveConfigMock.mock.calls[1][5] as { noCache?: boolean };
    expect(opts.noCache).toBe(true);
    expect(setCalls).toHaveLength(2); // bypass renders are still published

    // …and the rewritten entry serves the next plain read.
    const again = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(again.cache).toBe('hit');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
  });

  it('does not publish a bypass render under a corrupt config version', async () => {
    kv.set(REDIS_KEYS.configVersion, 'not-a-version');
    const out = await mod.renderProfileConfig('default', { noCache: true });
    expect(out.cache).toBe('bypass');
    expect(setCalls).toHaveLength(0);
  });
});

describe('renderProfileConfig — uninitialised base', () => {
  it('throws the default 404 ProblemDetails', async () => {
    getBaseMock.mockResolvedValue(null);
    await expect(mod.renderProfileConfig('default', {})).rejects.toMatchObject({
      problem: { status: 404 },
    });
  });

  it('throws the route-supplied error instead when provided', async () => {
    getBaseMock.mockResolvedValue(null);
    await expect(
      mod.renderProfileConfig('default', {
        missingBaseError: () =>
          ProblemDetailsError.unprocessable('Base config has not been initialized.'),
      }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });
});

describe('renderProfileConfig — profile existence guard', () => {
  // A name with no profile record can't be located → 404 instead of silently
  // rendering. `default` resolves to a record (see the profilesRepo mock).
  it('404s a non-default name with no profile record', async () => {
    await expect(
      mod.renderProfileConfig('does-not-exist', { providerUrlBase: URL_BASE }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
    // The unknown name must not have written a cache entry.
    expect(setCalls).toHaveLength(0);
  });

  it('renders `default` via its profile record (loads per-profile base)', async () => {
    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.cache).toBe('miss');
    expect(out.resolved.content).toBe(RESOLVED.content);
  });
});

describe('renderProfileConfig — display_name propagation', () => {
  // The sub route reads displayName to set the Content-Disposition filename, and
  // must get it on a cache HIT too (no profile load on the fast path) — so it's
  // carried inside the cached entry, not re-fetched.
  it('returns the profile display_name on miss and carries it through to a hit', async () => {
    (DEFAULT_PROFILE as { display_name?: string }).display_name = '家庭主力 🏠';
    try {
      const miss = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
      expect(miss.cache).toBe('miss');
      expect(miss.displayName).toBe('家庭主力 🏠');

      const hit = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
      expect(hit.cache).toBe('hit');
      expect(hit.displayName).toBe('家庭主力 🏠'); // served from the cached entry
    } finally {
      delete (DEFAULT_PROFILE as { display_name?: string }).display_name;
    }
  });

  it('returns null when the profile has no display_name', async () => {
    const out = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(out.displayName).toBeNull();
  });
});
