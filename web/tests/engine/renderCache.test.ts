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

function readKey(key: string): unknown {
  if (counters.has(key)) return counters.get(key);
  return kv.get(key) ?? null;
}

const setCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];

const fakeRedis = {
  mget: async (...keys: string[]) => keys.map(readKey),
  get: async (key: string) => readKey(key),
  set: async (key: string, value: unknown, opts: unknown) => {
    kv.set(key, value);
    setCalls.push({ key, value, opts });
  },
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

// ---- mocked pipeline + repos ------------------------------------------------

const RESOLVED = {
  content: 'proxies: []\n',
  buildId: 'build-1',
  anchorsApplied: [],
  unmatchedAnchors: [],
  ruleProvidersApplied: [],
  subscriptions: [{ name: 'airport-a', injectedCount: 3 }],
  collisions: [],
  nodeNames: ['n1', 'n2', 'n3'],
  warnings: [],
  inlinedProxyCount: 3,
  proxyGroupCount: 0,
};

const resolveConfigMock = vi.fn(async (..._args: unknown[]) => ({ ...RESOLVED }));
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
vi.mock('@/lib/repos/profilesRepo', () => ({
  getProfileByName: async (name: string) => (name === 'default' ? DEFAULT_PROFILE : null),
}));

let mod: typeof import('@/lib/engine/renderCache');

beforeEach(async () => {
  kv.clear();
  counters.clear();
  setCalls.length = 0;
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
    expect(out.resolved.buildId).toBe('build-1');
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
});

describe('renderProfileConfig — invalidation paths', () => {
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
