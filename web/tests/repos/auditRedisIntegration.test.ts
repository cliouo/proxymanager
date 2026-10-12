import { findDistributionIdentity } from '@/lib/repos/distributionIdentityRepo';
/** Run with PM_REDIS_SERVER / PM_REDIS_CLI pointing at local Redis binaries. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ redis: {} as Record<string, unknown> }));
vi.mock('@/lib/redis/client', () => ({ getRedis: () => runtime.redis }));
import { auditedMutation } from '@/lib/repos/auditedMutation';
import { commitProfileConfigChanges } from '@/lib/repos/profileConfigMutationRepo';
import { recordEvents, listEvents, eventCursor, trimEvents } from '@/lib/repos/auditRepo';
import { readRulePage } from '@/lib/services/rulePage';
import { getDashboardSummary } from '@/lib/repos/dashboardRepo';
import {
  commitSubscriptionChange,
  commitSubscriptionDelete,
  getSubscription,
  listSubscriptions,
  listSubscriptionSummaries,
} from '@/lib/repos/subscriptionsRepo';
import type { Rule, Subscription } from '@/schemas';

const server = process.env.PM_REDIS_SERVER;
const cli = process.env.PM_REDIS_CLI;
describe.skipIf(!server || !cli)('isolated real Redis: atomic config and audit', () => {
  let process: ChildProcess;
  let dir: string;
  let socket: string;
  const commandLog: string[] = [];
  function command(...args: (string | number)[]): unknown {
    commandLog.push(String(args[0]).toUpperCase());
    const output = execFileSync(cli!, ['--json', '-s', socket, ...args.map(String)], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (output.startsWith('error:')) throw new Error(output);
    return JSON.parse(output);
  }
  const decode = (raw: unknown) => {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  function deserialize(value: unknown): unknown {
    return Array.isArray(value) ? value.map(deserialize) : decode(value);
  }
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pm-audit-test-'));
    socket = join(dir, 'redis.sock');
    process = spawn(
      server!,
      ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'],
      { stdio: 'ignore' },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (existsSync(socket) && command('PING') === 'PONG') break;
      } catch {
        /* socket not ready */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    runtime.redis = {
      eval: async (script: string, keys: string[], args: (string | number)[]) =>
        deserialize(command('EVAL', script, keys.length, ...keys, ...args)),
      get: async (key: string) => decode(command('GET', key)),
      set: async (key: string, value: unknown, options: { ex: number }) =>
        command('SET', key, JSON.stringify(value), 'EX', options.ex),
      hget: async (key: string, id: string) => decode(command('HGET', key, id)),
      mget: async (...keys: string[]) => (command('MGET', ...keys) as unknown[]).map(decode),
      hgetall: async (key: string) =>
        Object.fromEntries(
          Object.entries(command('HGETALL', key) as Record<string, unknown>).map(([id, value]) => [
            id,
            decode(value),
          ]),
        ),
      zrange: async (key: string, max: string, min: string, options?: { count: number }) =>
        options
          ? (
              command(
                'ZREVRANGEBYSCORE',
                key,
                max,
                min,
                'WITHSCORES',
                'LIMIT',
                0,
                options.count,
              ) as unknown[]
            ).flat()
          : command('ZRANGE', key, max, min),
      hmget: async (key: string, ...ids: string[]) =>
        Object.fromEntries(
          (command('HMGET', key, ...ids) as unknown[]).map((v, i) => [ids[i], decode(v)]),
        ),
      multi: () => {
        // Standalone audit API uses MULTI; config tests below execute the actual production Lua.
        const commands: Array<Array<string | number>> = [];
        const tx = {
          zadd: (key: string, ...items: { score: number; member: string }[]) => {
            commands.push(['ZADD', key, ...items.flatMap((item) => [item.score, item.member])]);
            return tx;
          },
          set: (key: string, value: unknown, options: { ex: number }) => {
            commands.push(['SET', key, JSON.stringify(value), 'EX', options.ex]);
            return tx;
          },
          expire: (key: string, seconds: number) => {
            commands.push(['EXPIRE', key, seconds]);
            return tx;
          },
          hset: (key: string, items: Record<string, unknown>) => {
            commands.push([
              'HSET',
              key,
              ...Object.entries(items).flatMap(([k, v]) => [k, JSON.stringify(v)]),
            ]);
            return tx;
          },
          exec: async () =>
            command(
              'EVAL',
              'for _, cmd in ipairs(cjson.decode(ARGV[1])) do redis.call(unpack(cmd)) end return 1',
              0,
              JSON.stringify(commands),
            ),
        };
        return tx;
      },
    };
  });
  afterAll(() => {
    process?.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    command('FLUSHDB');
  });
  const rule: Rule = {
    id: 'rule-a',
    revision: 1,
    options: [],
    anchor: 'manual',
    type: 'DOMAIN',
    value: 'example.com',
    policy: 'DIRECT',
    rank: 10,
    source: 'manual',
    added_at: 1,
    updated_at: 1,
  };
  const plan = async () => {
    await commitProfileConfigChanges('profile-a', { ruleWrites: [rule] }, 0);
    return {
      data: rule,
      events: [{ op: 'rule.create', actor: 'test', after: rule, ruleId: rule.id }],
    };
  };
  it('commits config, core audit and a replay receipt together', async () => {
    const identity = { id: 'test-operation-0001', fingerprint: 'fingerprint' };
    const first = await auditedMutation(plan, identity);
    const replay = await auditedMutation(() => {
      throw new Error('must not plan twice');
    }, identity);
    expect(replay).toEqual(first);
    expect(command('GET', 'config:version')).toBe('1');
    expect(command('HLEN', 'rules:profile-a')).toBe(1);
    expect(command('ZCARD', 'audit:events')).toBe(1);
    expect(decode(command('HGET', 'audit:by_id', first.events[0].id))).toMatchObject({
      after: rule,
    });
  });
  it('invalid audit storage fails BEFORE any configuration writes', async () => {
    command('SET', 'audit:by_id', 'wrong-type');
    await expect(auditedMutation(plan)).rejects.toThrow();
    expect(command('HLEN', 'rules:profile-a')).toBe(0);
    expect(command('GET', 'config:version')).toBe(null);
  });
  it('a stale CAS writes neither configuration nor events', async () => {
    command('SET', 'config:version', 1);
    await expect(auditedMutation(plan)).rejects.toMatchObject({ problem: { status: 412 } });
    expect(command('HLEN', 'rules:profile-a')).toBe(0);
    expect(command('ZCARD', 'audit:events')).toBe(0);
  });
  it('splits local bodies atomically and preserves empty arrays and legacy inline reads', async () => {
    const sub: Subscription = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'local',
      kind: 'local',
      enabled: true,
      content: '{"proxies":[]}',
      tags: [],
      operators: [],
      ttl_ms: 600000,
    };
    const ordinal = { expectedGeneration: 0, expectedGlobalSize: 0, sources: [] };
    expect(
      await commitSubscriptionChange(sub, 0, ordinal, { manualSnapshot: { type: 'delete' } }),
    ).toMatchObject({ ok: true });
    const meta = decode(command('HGET', 'subscriptions', sub.id));
    expect(meta).not.toHaveProperty('content');
    expect(meta).toMatchObject({ tags: [], operators: [] });
    expect(decode(command('GET', `subscription-local-content:${sub.id}`))).toBe(sub.content);
    expect(await getSubscription(sub.id)).toMatchObject({ content: sub.content });
    expect((await listSubscriptions())[0]).toMatchObject({ content: sub.content });
    expect((await listSubscriptionSummaries())[0]).not.toHaveProperty('content');
    // Failed CAS leaves both pieces unchanged.
    expect(
      await commitSubscriptionChange({ ...sub, content: 'new body' }, 0, ordinal, {
        manualSnapshot: { type: 'delete' },
      }),
    ).toMatchObject({ ok: false });
    expect(decode(command('GET', `subscription-local-content:${sub.id}`))).toBe(sub.content);
    expect(await commitSubscriptionDelete(sub.id, 1, ordinal)).toMatchObject({ ok: true });
    expect(command('GET', `subscription-local-content:${sub.id}`)).toBeNull();
    command('HSET', 'subscriptions', sub.id, JSON.stringify(sub));
    expect(await getSubscription(sub.id)).toMatchObject({ content: sub.content });
  });
  it('reads only page entities after building a stable query index', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      ...rule,
      id: `rule-${String(i).padStart(4, '0')}`,
      rank: i,
      value: `${i}.example`,
    }));
    command('HSET', 'rules:profile-a', ...rows.flatMap((row) => [row.id, JSON.stringify(row)]));
    const query = { sort: 'rank:asc' };
    const first = await readRulePage('profile-a', query, 0, 100);
    expect(first.meta.total).toBe(1001);
    commandLog.length = 0;
    const second = await readRulePage('profile-a', query, 100, 100);
    expect(second.data[0].id).toBe('rule-0100');
    expect(second.data).toHaveLength(100);
    expect(commandLog).toEqual(['MGET', 'ZRANGE', 'HMGET', 'GET']);
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(rows).length / 5);
    command('INCR', 'config:version');
    command('HDEL', 'rules:profile-a', 'rule-0100');
    expect((await readRulePage('profile-a', query, 100, 100)).data[0].id).toBe('rule-0101');
  });
  it('dashboard reads counts without transferring rule bodies or local subscription content', async () => {
    command('HSET', 'rules:profile-a', 'rule-a', JSON.stringify(rule));
    command(
      'HSET',
      'subscriptions',
      'sub-a',
      JSON.stringify({
        id: 'sub-a',
        name: 'local',
        kind: 'local',
        content: 'private-body'.repeat(10000),
      }),
    );
    const summary = await getDashboardSummary('profile-a');
    expect(summary.counts).toMatchObject({ rules: 1, subscriptions: 1 });
    expect(JSON.stringify(summary)).not.toContain('private-body');
    expect(JSON.stringify(summary).length).toBeLessThan(1000);
  });
  it('unauthenticated identity lookups project no legacy inline body', async () => {
    for (const [kind, key] of [
      ['subscription', 'subscriptions'],
      ['rule-set', 'rule-sets'],
    ] as const) {
      command(
        'HSET',
        key,
        'resource-a',
        JSON.stringify({
          id: 'resource-a',
          name: 'large',
          source: 'local',
          token_version: 2,
          content: 'private-body'.repeat(10000),
        }),
      );
      expect(await findDistributionIdentity(kind, 'large')).toEqual({
        id: 'resource-a',
        token_version: 2,
        source: 'local',
      });
      expect(await findDistributionIdentity(kind, 'missing')).toBeNull();
    }
  });
  it('500 core events use one configuration eval and one retention eval', async () => {
    const realEval = runtime.redis.eval as (...args: unknown[]) => Promise<unknown>;
    const observed = vi.fn(realEval);
    runtime.redis.eval = observed;
    try {
      const result = await auditedMutation(async () => {
        await commitProfileConfigChanges('profile-a', { ruleWrites: [rule] }, 0);
        return {
          data: rule.id,
          events: Array.from({ length: 500 }, (_, i) => ({
            op: 'rule.create',
            actor: 'test',
            ruleId: `rule-${i}`,
          })),
        };
      });
      expect(result.events).toHaveLength(500);
      expect(observed).toHaveBeenCalledTimes(2);
      expect(command('HLEN', 'audit:by_id')).toBe(500);
    } finally {
      runtime.redis.eval = realEval;
    }
  });
  it('undo links and empty-array snapshots persist in the same transaction', async () => {
    const first = await auditedMutation(plan);
    const undone = await auditedMutation(async () => {
      await commitProfileConfigChanges('profile-a', { ruleDeletes: [rule.id] }, 1);
      return {
        data: null,
        events: [{ op: 'rule.delete', actor: 'test', before: rule, undoes: first.events[0].id }],
      };
    });
    expect(command('HLEN', 'rules:profile-a')).toBe(0);
    expect(decode(command('HGET', 'audit:by_id', first.events[0].id))).toMatchObject({
      undone_by: undone.events[0].id,
      after: { options: [] },
    });
    expect(decode(command('HGET', 'audit:by_id', undone.events[0].id))).toMatchObject({
      before: { options: [] },
    });
  });
  it('retention failure does not turn a committed operation into an error', async () => {
    const realEval = runtime.redis.eval as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    runtime.redis.eval = (...args: unknown[]) => {
      if (++calls > 1) return Promise.reject(new Error('maintenance unavailable'));
      return realEval(...args);
    };
    try {
      expect((await auditedMutation(plan)).events).toHaveLength(1);
    } finally {
      runtime.redis.eval = realEval;
    }
    expect(command('HLEN', 'rules:profile-a')).toBe(1);
  });
  it('does not skip tied timestamps and retains exactly matching index/body IDs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
    try {
      await recordEvents(
        Array.from({ length: 1100 }, () => ({ op: 'rule.create', actor: 'test' })),
      );
      await Promise.all([trimEvents(), trimEvents()]);
      expect(command('ZCARD', 'audit:events')).toBe(1000);
      expect(command('HLEN', 'audit:by_id')).toBe(1000);
      const ids: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await listEvents({ limit: 100, cursor });
        if (!page.length) break;
        ids.push(...page.map((e) => e.id));
        cursor = eventCursor(page[page.length - 1]);
      }
      expect(new Set(ids).size).toBe(1000);
      expect(ids).toHaveLength(1000);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
