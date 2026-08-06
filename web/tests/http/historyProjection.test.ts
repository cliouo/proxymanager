/**
 * pass-8 blocker 7: GET /api/v1/history must NEVER return raw entity/profile
 * UUIDs for naming events — target.id projects to the profile-bound ref and
 * profileId to a keyed profile handle; non-naming events pass through.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { buildProfileScope, buildTargetRefScope } from '@/lib/proxies/handleScopes';
import { GLOBAL_NAMING_SCOPE_ID } from '@/lib/services/namingTargetScope';
import { GET } from '@/app/api/v1/history/route';

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
    const m = bucket(key);
    for (const [id, v] of Object.entries(payload)) m.set(id, v);
  },
  zrange: async () => [...bucket(REDIS_KEYS.audit.events).keys()],
  hmget: async (key: string, ...ids: string[]) => {
    const m = bucket(key);
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const v = m.get(id);
      if (v !== undefined) out[id] = typeof v === 'string' ? JSON.parse(v) : v;
    }
    return out;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

const PROFILE_ID = '99999999-9999-4999-8999-999999999999';
const SUB_ID = '11111111-1111-4111-8111-111111111111';

function seedNamingEvent(): void {
  const event = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ts: 1000,
    op: 'naming.apply',
    actor: 'web-ui',
    target: { kind: 'naming-source', type: 'subscription', id: SUB_ID, name: '机场A' },
    before: null,
    after: { templateSummary: { placeholderCount: 1, length: 8 }, mode: 'added' },
    undoable: false,
    profileId: PROFILE_ID,
  };
  bucket(REDIS_KEYS.audit.events).set(event.id, 1000);
  bucket(REDIS_KEYS.audit.byId).set(event.id, JSON.stringify(event));
  // a NON-naming event passes through untouched
  const ruleEvent = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ts: 999,
    op: 'rule.create',
    actor: 'web-ui',
    target: { kind: 'rule', id: 'rule-1', name: 'DIRECT' },
    before: null,
    after: { id: 'rule-1' },
    undoable: true,
    profileId: PROFILE_ID,
  };
  bucket(REDIS_KEYS.audit.events).set(ruleEvent.id, 999);
  bucket(REDIS_KEYS.audit.byId).set(ruleEvent.id, JSON.stringify(ruleEvent));
}

beforeAll(() => {
  installTestHandleSecret();
});

beforeEach(() => {
  stores.clear();
  seedNamingEvent();
});

afterEach(() => vi.restoreAllMocks());

describe('GET /api/v1/history — pass-8 blocker 7 external privacy', () => {
  it('naming events project target.id → profile-bound ref and profileId → keyed handle; no raw UUIDs anywhere', async () => {
    const res = await GET(new Request('http://localhost/api/v1/history'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        op: string;
        target?: { kind: string; type: string; id: string; name: string };
        profileId?: string;
      }>;
    };
    const naming = body.data.find((e) => e.op === 'naming.apply')!;
    expect(naming.target?.id).toBe(
      buildTargetRefScope(PROFILE_ID, [{ type: 'subscription', id: SUB_ID }]).project(
        `subscription:${SUB_ID}`,
      ),
    );
    expect(naming.target?.id).toMatch(/^ref-[0-9a-f]{16}$/);
    expect(naming.profileId).toBe(
      buildProfileScope(PROFILE_ID, [PROFILE_ID]).project(`profile:${PROFILE_ID}`),
    );
    // the NAMING event carries no raw entity/profile UUID anywhere
    const namingBlob = JSON.stringify(naming);
    expect(namingBlob).not.toContain(SUB_ID);
    expect(namingBlob).not.toContain(PROFILE_ID);
    // the display name survives (it is the bounded label, not an id)
    expect(naming.target?.name).toBe('机场A');
  });

  it('non-naming events pass through unchanged', async () => {
    const res = await GET(new Request('http://localhost/api/v1/history'));
    const body = (await res.json()) as { data: Array<{ op: string; target?: { id: string } }> };
    const rule = body.data.find((e) => e.op === 'rule.create')!;
    expect(rule.target?.id).toBe('rule-1');
  });

  it('projects global workspace naming audits without inventing a profile binding', async () => {
    const globalEvent = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ts: 1001,
      op: 'naming.apply',
      actor: 'web-ui',
      target: { kind: 'naming-source', type: 'subscription', id: SUB_ID, name: '机场A' },
      before: null,
      after: { templateSummary: { placeholderCount: 1, length: 8 }, mode: 'added' },
      undoable: false,
      scope: 'global',
    };
    bucket(REDIS_KEYS.audit.events).set(globalEvent.id, globalEvent.ts);
    bucket(REDIS_KEYS.audit.byId).set(globalEvent.id, JSON.stringify(globalEvent));

    const res = await GET(new Request('http://localhost/api/v1/history'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        scope?: string;
        profileId?: string;
        target?: { id: string };
      }>;
    };
    const projected = body.data.find((event) => event.id === globalEvent.id)!;
    expect(projected.scope).toBe('global');
    expect(projected.profileId).toBeUndefined();
    expect(projected.target?.id).toBe(
      buildTargetRefScope(GLOBAL_NAMING_SCOPE_ID, [{ type: 'subscription', id: SUB_ID }]).project(
        `subscription:${SUB_ID}`,
      ),
    );
    expect(JSON.stringify(projected)).not.toContain(SUB_ID);
  });

  it('drops malformed legacy naming events that cannot be projected without leaking raw ids', async () => {
    const malformed = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ts: 997,
      op: 'naming.apply',
      actor: 'legacy',
      target: { kind: 'naming-source', type: 'subscription', id: SUB_ID, name: '机场A' },
      before: null,
      after: { templateSummary: { placeholderCount: 1, length: 8 }, mode: 'added' },
      undoable: false,
      // profileId deliberately missing: no safe profile-bound ref can be minted.
    };
    bucket(REDIS_KEYS.audit.events).set(malformed.id, malformed.ts);
    bucket(REDIS_KEYS.audit.byId).set(malformed.id, JSON.stringify(malformed));

    const res = await GET(new Request('http://localhost/api/v1/history'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { count: number } };
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(malformed.id);
    expect(body.data).toHaveLength(2);
    expect(body.meta.count).toBe(2);
  });

  it('drops naming op rows even when a corrupt target kind tries to bypass naming projection', async () => {
    const malformed = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      ts: 996,
      op: 'naming.apply',
      actor: 'legacy',
      target: { kind: 'rule', type: 'subscription', id: SUB_ID, name: '机场A' },
      before: null,
      after: { templateSummary: { placeholderCount: 1, length: 8 }, mode: 'added' },
      undoable: false,
      profileId: PROFILE_ID,
    };
    bucket(REDIS_KEYS.audit.events).set(malformed.id, malformed.ts);
    bucket(REDIS_KEYS.audit.byId).set(malformed.id, JSON.stringify(malformed));

    const res = await GET(new Request('http://localhost/api/v1/history'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { count: number } };
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(malformed.id);
    expect(serialized).not.toContain(SUB_ID);
    expect(body.data).toHaveLength(2);
    expect(body.meta.count).toBe(2);
  });

  it('pass-10 blocker 3: multi-event target-ref MAC collisions are detected as ONE domain — the batch projector fails closed', async () => {
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    // two naming events on DIFFERENT targets/profiles — under a colliding
    // signer their projected refs collide; the batch projector must reject
    const second = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ts: 998,
      op: 'naming.apply',
      actor: 'web-ui',
      target: {
        kind: 'naming-source',
        type: 'collection',
        id: '22222222-2222-4222-8222-222222222222',
        name: '聚合池',
      },
      before: null,
      after: { templateSummary: { placeholderCount: 1, length: 8 }, mode: 'added' },
      undoable: false,
      profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    bucket(REDIS_KEYS.audit.events).set(second.id, 998);
    bucket(REDIS_KEYS.audit.byId).set(second.id, JSON.stringify(second));
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      const res = await GET(new Request('http://localhost/api/v1/history'));
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('句柄冲突');
      expect(text).not.toContain('deadbeef');
    } finally {
      injectHandleSignerForTests(null);
    }
  });
});
