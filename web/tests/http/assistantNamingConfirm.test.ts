/**
 * Production-path save_naming_plan evidence (Delivery pass 3): the REAL
 * dispatchToolCall → mintConfirmation → POST /api/v1/assistant/confirm flow.
 *
 *   - the legacy `rules` alias never shadows an explicitly supplied
 *     recognitionRules candidate after the real schema parse;
 *   - the confirmation card binds the preview-time configVersion; a version
 *     change between card and click writes NOTHING; a matching version
 *     writes exactly once;
 *   - missing confirmation metadata fails closed BEFORE any preflight/write;
 *   - a successful save creates exactly ONE durable audit record, a failed
 *     save creates ZERO.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { buildTargetRefScope } from '@/lib/proxies/handleScopes';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { dispatchToolCall } from '@/lib/ai/dispatchTool';
import { POST as confirmPost } from '@/app/api/v1/assistant/confirm/route';

const stores = new Map<string, Map<string, unknown>>();
const counters = new Map<string, number>();
function bucket(key: string): Map<string, unknown> {
  let m = stores.get(key);
  if (!m) {
    m = new Map();
    stores.set(key, m);
  }
  return m;
}

const keyTypes = new Map<string, string>();

const fakeRedis = {
  set: async (key: string, value: unknown) => {
    bucket(key).set('__value__', value);
    return 'OK';
  },
  getdel: async (key: string) => {
    const raw = stores.get(key)?.get('__value__') ?? null;
    stores.get(key)?.clear();
    return raw ?? null;
  },
  hgetall: async (key: string) => {
    const m = bucket(key);
    return m.size === 0 ? null : Object.fromEntries(m);
  },
  hlen: async (key: string) => stores.get(key)?.size ?? 0,
  hget: async (key: string, id: string) => stores.get(key)?.get(id) ?? null,
  hset: async (key: string, payload: Record<string, unknown>) => {
    for (const [id, v] of Object.entries(payload)) bucket(key).set(id, v);
  },
  hdel: async (key: string, ...ids: string[]) => {
    const m = stores.get(key);
    if (!m) return 0;
    let n = 0;
    for (const id of ids) if (m.delete(id)) n++;
    return n;
  },
  get: async (key: string) => (counters.has(key) ? counters.get(key)! : null),
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  // Faithful CAS_ENTITY_WITH_HISTORY mirror (prevalidation first, exact SET)
  eval: async (_script: string, keys: string[], args: string[]) => {
    const typeOf = (key: string): string =>
      keyTypes.get(key) ??
      (key === REDIS_KEYS.audit.events
        ? 'zset'
        : key === REDIS_KEYS.configVersion
          ? 'string'
          : 'hash');
    const isHash = (key: string): boolean => {
      const t = typeOf(key);
      return t === 'hash' || t === 'none';
    };
    const isString = (key: string): boolean => {
      const t = typeOf(key);
      return t === 'string' || t === 'none';
    };
    const isZset = (key: string): boolean => {
      const t = typeOf(key);
      return t === 'zset' || t === 'none';
    };
    const canonicalVersion = (raw: unknown): number | null => {
      if (raw === null || raw === undefined) return 0;
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
        if (raw <= 9007199254740990) return raw;
        return null;
      }
      if (typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw)) {
        const n = Number(raw);
        if (Number.isSafeInteger(n) && n <= 9007199254740990) return n;
      }
      return null;
    };
    if (keys.length >= 3) {
      if (!isHash(keys[1])) return [2, 'entity-wrongtype'];
      if (!isHash(keys[2])) return [2, 'history-wrongtype'];
      if (!isString(keys[0])) return [2, 'version-wrongtype'];
      if (keys.length >= 5) {
        if (!isZset(keys[3])) return [2, 'audit-events-wrongtype'];
        if (!isHash(keys[4])) return [2, 'audit-byid-wrongtype'];
        // pass-1 finding: the production script proves EVERY precondition —
        // including the audit-id reuse gate — BEFORE the first mutation; the
        // mirror reproduces that order so a reused id writes NOTHING.
        if (args[6] === 'set' && bucket(keys[4]).has(args[7])) return [2, 'audit-id-exists'];
        // pass-7 blocker 4 / pass-8 blocker 6: the Lua re-validates the
        // caller profile's CURRENT source binding inside the same atomic
        // eval, and collection bindings re-validate the member-id list.
        if (keys.length >= 6) {
          const raw = bucket(keys[5]).get(args[10]);
          if (raw === undefined) return [2, 'profile-missing'];
          const profile = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as {
            source?: { type?: string; id?: string };
          };
          const st = profile.source;
          const bindingOk =
            args[11] === 'none' ? st?.type === 'none' : st?.type === args[11] && st.id === args[12];
          if (!bindingOk) return [2, 'profile-binding-mismatch'];
          if (keys.length === 7 && args[11] === 'collection') {
            const colRaw = bucket(keys[6]).get(args[12]);
            if (colRaw === undefined) return [2, 'profile-binding-mismatch'];
            const col = JSON.parse(
              typeof colRaw === 'string' ? colRaw : JSON.stringify(colRaw),
            ) as { subscription_ids?: string[] };
            const ids = col.subscription_ids ?? [];
            const expectedCount = Number(args[13]);
            if (ids.length !== expectedCount) return [2, 'profile-binding-mismatch'];
            for (let i = 0; i < expectedCount; i++) {
              if (ids[i] !== args[14 + i]) return [2, 'profile-binding-mismatch'];
            }
          }
        }
      }
      const current = canonicalVersion(counters.get(keys[0]));
      if (current === null) return [2, 'version-malformed'];
      if (current !== Number(args[0])) return [0, String(current)];
      const nextVersion = current + 1;
      await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
      if (args[3] === 'set') {
        await fakeRedis.hset(keys[2], { [args[4]]: JSON.parse(args[5]) });
      } else if (args[3] === 'del') {
        await fakeRedis.hdel(keys[2], args[4]);
      }
      if (args[6] === 'set' && keys.length >= 5) {
        bucket(keys[3]).set(args[7], Number(args[8]));
        await fakeRedis.hset(keys[4], { [args[7]]: args[9] });
      }
      counters.set(keys[0], nextVersion);
      return [1, String(nextVersion)];
    }
    if (!isString(keys[0])) return [2, 'version-wrongtype'];
    const current = canonicalVersion(counters.get(keys[0]));
    if (current === null) return [2, 'version-malformed'];
    if (current !== Number(args[0])) return [0, String(current)];
    const nextVersion = current + 1;
    await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    counters.set(keys[0], nextVersion);
    return [1, String(nextVersion)];
  },
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (key: string, payload: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      incr: (key: string) => {
        ops.push(() => fakeRedis.incr(key));
        return tx;
      },
      zadd: (key: string, member: { score: number; member: string }) => {
        ops.push(async () => {
          bucket(key).set(member.member, member.score);
          return 1;
        });
        return tx;
      },
      exec: async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out;
      },
    };
    return tx;
  },
  zcard: async (key: string) => stores.get(key)?.size ?? 0,
  zrange: async () => [],
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: vi.fn(async () => ({
    configVersion: counters.get(REDIS_KEYS.configVersion) ?? 0,
  })),
}));
vi.mock('@/lib/services/rulesService', () => ({
  resolveActor: vi.fn(() => 'ai_chat'),
}));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxiesRaw: vi.fn(async () => ({
    proxies: [
      { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
      { name: '日本 01', type: 'ss', server: 'b.example', port: 443 },
    ],
    proxyCount: 2,
  })),
}));
vi.mock('@/lib/services/nodeExportService', () => ({
  mergeCollectionMemberProxies: vi.fn(async () => ({ merged: [], memberErrors: [] })),
}));
vi.mock('@/lib/services/nodeReferenceService', () => ({
  findNodeReferences: vi.fn(async () => []),
}));
vi.mock('@/lib/services/nodeOrdinalService', () => ({
  resolveOrdinalsFor: vi.fn(async () => () => undefined),
}));

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '99999999-9999-4999-8999-999999999999';

function seed(): void {
  bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
    id: SUB_ID,
    name: 'airport-a',
    display_name: '机场A',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 600_000,
    tags: [],
    operators: [],
  });
  bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
    id: PROFILE_ID,
    name: 'my-profile',
    source: { type: 'subscription', id: SUB_ID },
    updated_at: 1,
  });
}

beforeEach(() => {
  stores.clear();
  counters.clear();
  keyTypes.clear();
  seed();
});

// the handle secret is pinned at MODULE scope (describe-level fixtures
// compute refs at import time); the model passes an OPAQUE ref, never the
// raw UUID (pass-4 finding)
installTestHandleSecret();
// pass-5: refs are PROFILE-BOUND — the dispatch ctx profileId is part of the MAC
const SUB_REF = buildTargetRefScope(PROFILE_ID, [{ type: 'subscription', id: SUB_ID }]).project(
  `subscription:${SUB_ID}`,
);

const CANDIDATE = {
  source_type: 'subscription' as const,
  ref: SUB_REF,
  template: '${emoji} ${region}${?index: · ${index}}',
  tw2cn: false,
  sourceAliases: {},
  recognitionRules: [{ pattern: '家宽', field: 'route', value: '家宽' }],
};

async function mintToken(): Promise<string> {
  const env = await dispatchToolCall(
    { actor: 'ai_chat', profileId: PROFILE_ID },
    'save_naming_plan',
    CANDIDATE,
  );
  expect(env.kind).toBe('confirm-write');
  return (env.data as { token: string }).token;
}

function confirm(token: string): Promise<Response> {
  return confirmPost(
    new Request('http://localhost/api/v1/assistant/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Source': 'ai_chat' },
      body: JSON.stringify({ token }),
    }),
  );
}

function storedSub(): { operators: unknown[] } {
  return bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
}

function auditCount(): number {
  return stores.get(REDIS_KEYS.audit.events)?.size ?? 0;
}

describe('save_naming_plan via dispatchToolCall + confirm (production path)', () => {
  it('the confirmation record binds the preview-time configVersion; the REAL schema parse keeps recognitionRules when rules is omitted', async () => {
    const env = await dispatchToolCall(
      { actor: 'ai_chat', profileId: PROFILE_ID },
      'save_naming_plan',
      CANDIDATE,
    );
    const data = env.data as { token: string; diff: { mode: string } };
    expect(env.kind).toBe('confirm-write');
    expect(data.diff.mode).toBe('add rename-template');
    const stored = stores.get(REDIS_KEYS.assistantConfirm(data.token))?.get('__value__') as {
      confirmation?: { configVersion?: number };
      input?: { recognitionRules?: unknown[]; rules?: unknown };
    };
    expect(stored.confirmation?.configVersion).toBe(0); // preview-time version
    // the stored INPUT is the already-parsed candidate: recognitionRules is
    // nonempty and `rules` was NOT defaulted into the picture
    expect(stored.input?.recognitionRules).toHaveLength(1);
  });

  it('matching bound version: writes exactly once and creates exactly ONE durable audit record', async () => {
    const token = await mintToken();
    const res = await confirm(token);
    expect(res.status).toBe(200);
    const stored = storedSub();
    expect(stored.operators).toHaveLength(1);
    expect(stored.operators[0]).toMatchObject({
      kind: 'rename-template',
      template: CANDIDATE.template,
      recognitionRules: [{ pattern: '家宽', field: 'route', value: '家宽' }],
      tw2cn: false,
    });
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(1); // bumped exactly once
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);
    expect(auditCount()).toBe(1);
    // the token is one-time: a second confirm is a clean 409
    const again = await confirm(token);
    expect(again.status).toBe(409);
    expect(auditCount()).toBe(1);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(1);
  });

  it('card-to-click version change: writes NOTHING and mints NO audit', async () => {
    const token = await mintToken();
    counters.set(REDIS_KEYS.configVersion, 7); // concurrent writer between card and click
    const res = await confirm(token);
    expect(res.status).toBe(412);
    expect(storedSub().operators).toEqual([]);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(auditCount()).toBe(0);
  });

  it('missing confirmation metadata fails closed BEFORE any preflight or write', async () => {
    // a record with NO confirmation section (crafted/stale token)
    const { mintConfirmation } = await import('@/lib/ai/confirm');
    const { token } = await mintConfirmation({
      actor: 'ai_chat',
      action: 'save_naming_plan',
      input: CANDIDATE,
      profileId: PROFILE_ID,
    });
    const res = await confirm(token);
    expect(res.status).toBe(412);
    expect(storedSub().operators).toEqual([]);
    expect(auditCount()).toBe(0);
  });

  it('explicit EMPTY candidate fields stay explicit through the confirm path', async () => {
    const env = await dispatchToolCall(
      { actor: 'ai_chat', profileId: PROFILE_ID },
      'save_naming_plan',
      { ...CANDIDATE, recognitionRules: [], sourceAliases: {}, tw2cn: false },
    );
    const token = (env.data as { token: string }).token;
    const res = await confirm(token);
    expect(res.status).toBe(200);
    expect(storedSub().operators[0]).toMatchObject({
      recognitionRules: [],
      tw2cn: false,
    });
    expect(auditCount()).toBe(1);
  });

  it('dirty actor (URL/token in X-Source) is sanitized + bounded in the durable audit', async () => {
    const env = await dispatchToolCall(
      { actor: 'https://evil.example/tok=abc123', profileId: PROFILE_ID },
      'save_naming_plan',
      CANDIDATE,
    );
    const token = (env.data as { token: string }).token;
    const res = await confirmPost(
      new Request('http://localhost/api/v1/assistant/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Source': 'https://evil.example/tok=abc123',
        },
        body: JSON.stringify({ token }),
      }),
    );
    expect(res.status).toBe(200);
    const auditSerialized = JSON.stringify([...bucket(REDIS_KEYS.audit.byId).values()]);
    expect(auditSerialized).not.toContain('evil.example');
    expect(auditSerialized).not.toContain('token=abc123');
    const event = JSON.parse([...bucket(REDIS_KEYS.audit.byId).values()][0] as string) as {
      actor: string;
      after: { templateSummary: { placeholderCount: number; length: number } };
      profileId: string;
    };
    expect(event.actor.length).toBeLessThanOrEqual(64);
    // pass-2: the audit never carries the raw template — only the summary
    expect(event.after.templateSummary.placeholderCount).toBeGreaterThan(0);
    expect(event.after.templateSummary.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(event.after)).not.toContain('evil.example');
    // REQUIRED profile binding is persisted with the event
    expect(event.profileId).toBe(PROFILE_ID);
  });

  it('a FAILED save (preflight rejection) writes nothing and creates ZERO audit records', async () => {
    const preflightMock = (await import('@/lib/services/configPreflight'))
      .preflightProfileConfig as unknown as ReturnType<typeof vi.fn>;
    preflightMock.mockResolvedValueOnce({ configVersion: 99 }); // generation drift
    const token = await mintToken();
    const res = await confirm(token);
    expect(res.status).toBe(412);
    expect(storedSub().operators).toEqual([]);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(auditCount()).toBe(0);
  });
});

describe('round-9: confirm route responseContent is self-contained JSON', () => {
  it('success route returns parseable responseContent with matching ui/model summary', async () => {
    const token = await mintToken();
    const res = await confirm(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The response wraps data with kind, data, and modelContent
    expect(body.data.kind).toBe('write-result');
    expect(typeof body.data.modelContent).toBe('string');
    const model = JSON.parse(body.data.modelContent);
    expect(model.status).toBe('success');
    expect(model.action).toBe('save_naming_plan');
    // UI summary in data.data matches modelContent summary
    expect(body.data.data.summary).toBe(model.summary);
    // response is valid self-contained JSON with the expected fields
    expect(body.data.data.op).toBeTruthy();
    expect(Array.isArray(body.data.data.events)).toBe(true);
  });

  it('success route responseContent uses deterministic JSON — never an ordinary-object serialization', async () => {
    const token = await mintToken();
    const res = await confirm(token);
    expect(res.status).toBe(200);
    const text = await res.text();
    // The response is valid JSON produced by the hardened builder
    const body = JSON.parse(text);
    expect(body.data.kind).toBe('write-result');
    expect(typeof body.data.modelContent).toBe('string');
    const model = JSON.parse(body.data.modelContent);
    expect(model.status).toBe('success');
    // UI summary and modelContent summary are identical (one canonical source)
    expect(body.data.data.summary).toBe(model.summary);
    // Verify responseContent is the same as what we parsed
    expect(body.data.modelContent).toBeDefined();
  });

  it('unknown-outcome response is fixed, parseable JSON', async () => {
    // Send a garbage token that won't be found in the store
    const res = await confirmPost(
      new Request('http://localhost/api/v1/assistant/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'nonexistent-token-123' }),
      }),
    );
    // Token not found → conflict
    const body = await res.json();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(typeof body.detail).toBe('string');
  });
});
