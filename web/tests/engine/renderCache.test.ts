import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsError } from '@/lib/http/problem';
import { REDIS_KEYS } from '@/lib/redis/keys';

/**
 * Fresh rendering and version-bracket regressions. Source cache behaviour
 * is covered separately by subscription fetcher tests.
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
  resolveConfigMock.mockReset();
  resolveConfigMock.mockImplementation(async () => ({ ...RESOLVED }));
  getBaseMock.mockClear();
  getBaseMock.mockImplementation(async () => BASE);
  vi.restoreAllMocks();
  mod = await import('@/lib/engine/renderCache');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const URL_BASE = 'https://pm.example/api/rule-providers/tok';

describe('renderProfileConfig — subscription caches are the only content cache', () => {
  it('ignores a legacy complete-config cache and renders on every request', async () => {
    const key = REDIS_KEYS.renderCache('default');
    const legacy = {
      ...RESOLVED,
      content: 'old port: 63333',
      epoch: 22,
      version: 0,
      providerUrlBase: URL_BASE,
      renderedAt: Date.now(),
      freshForMs: 600_000,
      baseEtag: BASE.etag,
      baseUpdatedAt: BASE.updated_at,
      displayName: null,
    };
    kv.set(key, legacy);
    const first = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    resolveConfigMock.mockResolvedValueOnce({ ...RESOLVED, content: 'new port: 64321' });
    const second = await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(first.resolved.content).toBe(RESOLVED.content);
    expect(second.resolved.content).toBe('new port: 64321');
    expect(second.cache).toBe('miss');
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
    expect(setCalls).toHaveLength(0);
    expect(kv.get(key)).toBe(legacy);
  });

  it('preserves source cache reads by default and forwards forced refresh and health options', async () => {
    await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    expect(resolveConfigMock.mock.calls[0][5]).toMatchObject({
      providerUrlBase: URL_BASE,
      noCache: undefined,
      recordFetchHealth: true,
      ignoreFailedSubs: false,
      ordinalConfigVersion: 0,
    });
    const forced = await mod.renderProfileConfig('default', {
      noCache: true,
      recordFetchHealth: false,
    });
    expect(forced.cache).toBe('bypass');
    expect(resolveConfigMock.mock.calls[1][5]).toMatchObject({
      noCache: true,
      recordFetchHealth: false,
    });
    expect(setCalls).toHaveLength(0);
  });

  it('fails closed if rendering fails, even with a retained legacy render', async () => {
    kv.set(REDIS_KEYS.renderCache('default'), RESOLVED);
    resolveConfigMock.mockRejectedValueOnce(new Error('invalid final config'));
    await expect(mod.renderProfileConfig('default')).rejects.toThrow('invalid final config');
    expect(setCalls).toHaveLength(0);
  });

  it('retries from fresh records when config changes during rendering', async () => {
    resolveConfigMock.mockImplementationOnce(async () => {
      counters.set(REDIS_KEYS.configVersion, 1);
      return { ...RESOLVED, content: 'obsolete' };
    });
    const out = await mod.renderProfileConfig('default');
    expect(out.resolved.content).toBe(RESOLVED.content);
    expect(resolveConfigMock).toHaveBeenCalledTimes(2);
    expect(resolveConfigMock.mock.calls[1][5]).toMatchObject({ ordinalConfigVersion: 1 });
    expect(getBaseMock).toHaveBeenCalledTimes(2);
  });

  it('returns 412 after three continuously superseded snapshots', async () => {
    resolveConfigMock.mockImplementation(async () => {
      await fakeRedis.incr(REDIS_KEYS.configVersion);
      return { ...RESOLVED };
    });
    await expect(mod.renderProfileConfig('default')).rejects.toMatchObject({
      problem: { status: 412 },
    });
    expect(resolveConfigMock).toHaveBeenCalledTimes(3);
  });

  it('captures the version before reading config data', async () => {
    getBaseMock.mockImplementationOnce(async () => {
      counters.set(REDIS_KEYS.configVersion, 1);
      return BASE;
    });
    await mod.renderProfileConfig('default');
    expect(resolveConfigMock.mock.calls[0][5]).toMatchObject({ ordinalConfigVersion: 0 });
    expect(resolveConfigMock.mock.calls[1][5]).toMatchObject({ ordinalConfigVersion: 1 });
  });

  it('repairs a corrupt generation and captures the repaired value before rendering', async () => {
    kv.set(REDIS_KEYS.configVersion, 'broken');
    await mod.renderProfileConfig('default');
    expect(evalCalls).toHaveLength(1);
    expect(resolveConfigMock.mock.calls[0][5]).toMatchObject({
      ordinalConfigVersion: readKey(REDIS_KEYS.configVersion),
    });
  });

  it('does not overwrite a concurrent valid generation during repair', async () => {
    kv.set(REDIS_KEYS.configVersion, 'broken');
    beforeRepairEval = async () => {
      kv.set(REDIS_KEYS.configVersion, 8);
    };
    await mod.renderProfileConfig('default');
    expect(readKey(REDIS_KEYS.configVersion)).toBe(8);
    expect(resolveConfigMock.mock.calls[0][5]).toMatchObject({ ordinalConfigVersion: 8 });
  });

  it('rejects an unknown profile and an uninitialised base', async () => {
    await expect(mod.renderProfileConfig('missing')).rejects.toMatchObject({
      problem: { status: 404 },
    });
    getBaseMock.mockResolvedValue(null);
    await expect(mod.renderProfileConfig('default')).rejects.toMatchObject({
      problem: { status: 404 },
    });
    await expect(
      mod.renderProfileConfig('default', {
        missingBaseError: () => ProblemDetailsError.unprocessable('Base missing'),
      }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });

  it('reads the current display name on every request', async () => {
    expect((await mod.renderProfileConfig('default')).displayName).toBeNull();
    (DEFAULT_PROFILE as { display_name?: string }).display_name = 'Updated';
    try {
      expect((await mod.renderProfileConfig('default')).displayName).toBe('Updated');
    } finally {
      delete (DEFAULT_PROFILE as { display_name?: string }).display_name;
    }
  });
});

it('local dependency URLs carry the rule-set capability, never the visiting profile token', async () => {
  vi.stubEnv('SUB_TOKEN', 'isolated-master');
  try {
    await mod.renderProfileConfig('default', {
      providerUrlBase: 'https://pm.test/api/rule-providers/profile-token',
    });
    const options = resolveConfigMock.mock.calls[0][5] as { providerUrl: (p: unknown) => string };
    const url = new URL(options.providerUrl({ id: 'rules-id', name: 'private-rules' }));
    const { requireSubToken, deriveSubToken } = await import('@/lib/auth');
    const token = url.pathname.split('/')[3];
    expect(() => requireSubToken(token, { type: 'rule-set', id: 'rules-id' })).not.toThrow();
    expect(() =>
      requireSubToken(deriveSubToken({ type: 'profile', id: 'profile-id' }), {
        type: 'rule-set',
        id: 'rules-id',
      }),
    ).toThrow();
    expect(url.pathname.endsWith('/private-rules')).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([false, true])(
  'refuses a name rebound to another authenticated profile (warm=%s)',
  async (warm) => {
    if (warm) await mod.renderProfileConfig('default', { providerUrlBase: URL_BASE });
    const bound = { providerUrlBase: URL_BASE, expectedProfileId: 'previous-owner' };
    await expect(mod.renderProfileConfig('default', bound)).rejects.toMatchObject({
      problem: { status: 404 },
    });
    expect(resolveConfigMock).toHaveBeenCalledTimes(warm ? 1 : 0);
  },
);
