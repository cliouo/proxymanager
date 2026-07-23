/**
 * `chained-proxy` — Mihomo proxy chaining via wrapper proxy-groups.
 *
 * Why groups not `dialer-proxy` on individual proxies: the "real" proxies
 * are now injected at resolve time from subscriptions (see
 * lib/engine/resolve.ts). They don't have a literal entry in base.yaml's
 * `proxies:` section that we could attach a field to. Wrapper groups
 * (which live in the proxy-groups hash and reference the proxy by name)
 * work regardless of where the underlying proxy comes from — Mihomo
 * resolves the references against the fully-expanded config.
 *
 * Post-E1 the proxy-groups live in Redis (`proxy-groups` hash), not in
 * base.yaml. This scenario writes through the proxy-group service so
 * its mutations participate in name-uniqueness, dialer-proxy cycle
 * detection, rename cascade, and snapshot invalidation just like any
 * UI-issued edit.
 *
 * Modes
 *   Fixed chain    one group with `proxies: [B], dialer-proxy: F`
 *   Pool chain     two groups: a fronts-pool with [F1..Fn], plus a wrap
 *                  with `proxies: [B], dialer-proxy: <pool name>` — switching
 *                  the pool's selection in Clash UI swaps the active front
 *                  without rewriting YAML
 *
 * Naming
 *   Auto names: `chain:F-to-B` (fixed), `pool:B` + `chain:pool-to-B` (pool).
 *   User can override via payload.
 *
 * Each op carries enough state in before/after snapshots that the
 * matching inverse can undo via the existing /history pipeline. Cycle
 * detection in the service refuses chains that would loop.
 */

import { z } from 'zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  createProxyGroup,
  createProxyGroups,
  deleteProxyGroup,
  deleteProxyGroupsByName,
  getProxyGroupByName,
  listProxyGroups,
  patchProxyGroup,
} from '@/lib/services/proxyGroupService';
import type { ProxyGroup } from '@/schemas';
import type { AuditEventInput, InverseHandler, OpHandler, Scenario } from '../_shared/types';

/* ─── Payload schemas ───────────────────────────────────────────────── */

const NameSchema = z.string().min(1).max(128);

/**
 * Smart-pool defaults. The probe URL points at a *behind-the-wall* target on
 * purpose: a front node that can't reach it times out and drops from the
 * pool, so "passes the wall + fastest" becomes the selection criterion that
 * Clash evaluates at runtime — no node names are pinned.
 */
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
const DEFAULT_INTERVAL = 300;

/** fallback = stick to the first healthy front (stable chain); url-test = always chase the fastest. */
const PoolStrategySchema = z.enum(['fallback', 'url-test']);

/** The runtime-evaluated spec shared by smart-pool create + update. */
const SmartPoolSpec = z.object({
  strategy: PoolStrategySchema.default('fallback'),
  /** Region/keyword regex matched against live node names; empty = all nodes. */
  filter: z.string().trim().min(1).max(512).optional(),
  testUrl: z.string().url().max(512).optional(),
  interval: z.number().int().positive().max(86400).optional(),
});

const SetFixedChainPayload = z.object({
  backend: NameSchema,
  front: NameSchema,
  /** Optional override; otherwise auto-derived from front + backend. */
  chainName: NameSchema.optional(),
});

const ClearChainPayload = z.object({
  /** The wrapper group's name. */
  chainName: NameSchema,
});

const CreatePoolChainPayload = z.object({
  backend: NameSchema,
  fronts: z.array(NameSchema).min(1).max(64),
  /** Auto-derived from backend if omitted. */
  poolName: NameSchema.optional(),
  chainName: NameSchema.optional(),
});

const UpdatePoolMembersPayload = z.object({
  poolName: NameSchema,
  fronts: z.array(NameSchema).min(1).max(64),
});

const CreateSmartPoolChainPayload = SmartPoolSpec.extend({
  backend: NameSchema,
  poolName: NameSchema.optional(),
  chainName: NameSchema.optional(),
});

const UpdateSmartPoolPayload = SmartPoolSpec.extend({
  poolName: NameSchema,
});

const DeletePoolChainPayload = z.object({
  chainName: NameSchema,
});

/* ─── Snapshot shapes ───────────────────────────────────────────────── */

interface FixedChainSnapshot {
  chainName: string;
  backend: string;
  front: string;
}

/** Smart-pool config captured for faithful undo of a smart pool. */
interface SmartPoolSnapshot {
  strategy: z.infer<typeof PoolStrategySchema>;
  filter?: string;
  testUrl: string;
  interval: number;
}

interface PoolChainSnapshot {
  poolName: string;
  /** Manual pools list their members; smart pools leave this empty. */
  poolMembers: string[];
  chainName: string;
  backend: string;
  /** Present iff the pool is a smart (filter + auto-select) pool. */
  smart?: SmartPoolSnapshot;
}

/* ─── Validation helpers ────────────────────────────────────────────── */

/**
 * Look up a chained-proxy "wrap" group by name and validate it has the
 * single-backend + dialer-proxy shape this scenario emits. The detection
 * is intentionally narrow — opening up to arbitrary user-edited groups
 * would let `clear-chain` blow away non-chain groups that happen to fit.
 */
async function loadChainWrap(
  profileId: string,
  chainName: string,
): Promise<{ group: ProxyGroup; backend: string; front: string }> {
  const group = await getProxyGroupByName(profileId, chainName);
  if (!group) {
    throw ProblemDetailsError.notFound(`Chain group "${chainName}" not found.`);
  }
  const front = group['dialer-proxy'];
  const members = group.proxies ?? [];
  if (!front || members.length !== 1) {
    throw ProblemDetailsError.unprocessable(
      `Group "${chainName}" doesn't look like a chained-proxy wrap (need dialer-proxy + exactly one member).`,
    );
  }
  return { group, backend: members[0], front };
}

/* ─── Naming helpers ────────────────────────────────────────────────── */

function defaultFixedChainName(front: string, backend: string): string {
  return `chain:${front}-to-${backend}`;
}
function defaultPoolName(backend: string): string {
  return `pool:${backend}`;
}
function defaultPoolChainName(backend: string): string {
  return `chain:pool-to-${backend}`;
}

/* ─── Smart-pool helpers ────────────────────────────────────────────── */

/** Normalise a parsed SmartPoolSpec into the concrete values we persist. */
function resolveSmartSpec(spec: z.infer<typeof SmartPoolSpec>): SmartPoolSnapshot {
  return {
    strategy: spec.strategy,
    filter: spec.filter,
    testUrl: spec.testUrl ?? DEFAULT_TEST_URL,
    interval: spec.interval ?? DEFAULT_INTERVAL,
  };
}

/**
 * Build the proxy-group fields for a smart pool: pull every node in via
 * `include-all-proxies`, narrow by an optional region/keyword `filter`, and
 * let the `url-test`/`fallback` type pick a live front at runtime. No node
 * names are stored, so a subscription refresh can't break the pool.
 */
function smartPoolGroupInput(poolName: string, snap: SmartPoolSnapshot) {
  return {
    kind: 'filter' as const,
    name: poolName,
    type: snap.strategy,
    'include-all-proxies': true,
    ...(snap.filter ? { filter: snap.filter } : {}),
    url: snap.testUrl,
    interval: snap.interval,
    notes: 'chained-proxy: smart fronts pool',
  };
}

/* ─── Op handlers ───────────────────────────────────────────────────── */

const setFixedChain: OpHandler = async (ctx, raw) => {
  const { backend, front, chainName } = SetFixedChainPayload.parse(raw);
  if (backend === front) {
    throw ProblemDetailsError.unprocessable('backend and front must differ.');
  }
  const name = chainName ?? defaultFixedChainName(front, backend);

  await createProxyGroup(
    ctx.profileId,
    {
      kind: 'raw',
      name,
      type: 'select',
      proxies: [backend],
      'dialer-proxy': front,
      notes: 'chained-proxy: fixed chain',
    },
    ctx.configVersion,
  );

  await ctx.taxonomy.set(name, { kind: 'custom' }).catch(() => undefined);
  const snap: FixedChainSnapshot = { chainName: name, backend, front };
  return {
    data: { chainName: name, backend, front },
    events: [
      {
        action: 'set-fixed-chain',
        target: { kind: 'proxy-group', name },
        after: snap,
      },
    ] satisfies AuditEventInput[],
  };
};

const clearChain: OpHandler = async (ctx, raw) => {
  const { chainName } = ClearChainPayload.parse(raw);
  const { group, backend, front } = await loadChainWrap(ctx.profileId, chainName);
  await deleteProxyGroup(ctx.profileId, group.id, ctx.configVersion);
  await ctx.taxonomy.delete(chainName).catch(() => undefined);
  const snap: FixedChainSnapshot = { chainName, backend, front };
  return {
    data: { chainName, prev: snap },
    events: [
      {
        action: 'clear-chain',
        target: { kind: 'proxy-group', name: chainName },
        before: snap,
      },
    ] satisfies AuditEventInput[],
  };
};

const createPoolChain: OpHandler = async (ctx, raw) => {
  const {
    backend,
    fronts,
    poolName: poolNameOverride,
    chainName: chainNameOverride,
  } = CreatePoolChainPayload.parse(raw);

  if (fronts.includes(backend)) {
    throw ProblemDetailsError.unprocessable(
      `Backend "${backend}" cannot appear in the fronts pool.`,
    );
  }
  if (new Set(fronts).size !== fronts.length) {
    throw ProblemDetailsError.unprocessable('Pool fronts must be unique.');
  }

  const poolName = poolNameOverride ?? defaultPoolName(backend);
  const chainName = chainNameOverride ?? defaultPoolChainName(backend);

  // Batch-create so name-uniqueness + cycle detection see both groups
  // together; either both land or neither does (the helper pre-validates).
  await createProxyGroups(
    ctx.profileId,
    [
      {
        kind: 'raw',
        name: poolName,
        type: 'select',
        proxies: fronts,
        notes: 'chained-proxy: fronts pool',
      },
      {
        kind: 'raw',
        name: chainName,
        type: 'select',
        proxies: [backend],
        'dialer-proxy': poolName,
        notes: 'chained-proxy: pool-chain wrap',
      },
    ],
    ctx.configVersion,
  );

  await ctx.taxonomy.set(poolName, { kind: 'custom' }).catch(() => undefined);
  await ctx.taxonomy.set(chainName, { kind: 'custom' }).catch(() => undefined);

  const snap: PoolChainSnapshot = { poolName, poolMembers: fronts, chainName, backend };
  return {
    data: { poolName, chainName, backend, fronts },
    events: [
      {
        action: 'create-pool-chain',
        target: { kind: 'proxy-group', name: chainName },
        after: snap,
      },
    ] satisfies AuditEventInput[],
  };
};

const updatePoolMembers: OpHandler = async (ctx, raw) => {
  const { poolName, fronts } = UpdatePoolMembersPayload.parse(raw);
  if (new Set(fronts).size !== fronts.length) {
    throw ProblemDetailsError.unprocessable('Pool members must be unique.');
  }
  const group = await getProxyGroupByName(ctx.profileId, poolName);
  if (!group) {
    throw ProblemDetailsError.notFound(`proxy-group "${poolName}" not found.`);
  }
  // P3-9: a front that routes back through this very pool creates a traffic
  // loop (pool → wrap → dialer-proxy: pool → pool → …). Reject self-membership
  // and any member group whose dialer-proxy points at this pool.
  if (fronts.includes(poolName)) {
    throw ProblemDetailsError.unprocessable(
      `前置池「${poolName}」不能把自己作为成员(会造成流量回环)。`,
    );
  }
  const allGroups = await listProxyGroups(ctx.profileId);
  const loopers = allGroups
    .filter((g) => fronts.includes(g.name) && g['dialer-proxy'] === poolName)
    .map((g) => g.name);
  if (loopers.length > 0) {
    throw ProblemDetailsError.unprocessable(
      `成员 ${loopers.join('、')} 通过 dialer-proxy 又指回前置池「${poolName}」,会造成流量回环,已拒绝。`,
    );
  }
  const prevMembers = group.proxies ?? [];
  await patchProxyGroup(ctx.profileId, group.id, { proxies: fronts }, ctx.configVersion);
  return {
    data: { poolName, fronts },
    events: [
      {
        action: 'update-pool-members',
        target: { kind: 'proxy-group', name: poolName },
        before: { members: prevMembers },
        after: { members: fronts },
      },
    ] satisfies AuditEventInput[],
  };
};

const createSmartPoolChain: OpHandler = async (ctx, raw) => {
  const p = CreateSmartPoolChainPayload.parse(raw);
  const poolName = p.poolName ?? defaultPoolName(p.backend);
  const chainName = p.chainName ?? defaultPoolChainName(p.backend);
  if (poolName === chainName) {
    throw ProblemDetailsError.unprocessable('池名与链路名不能相同。');
  }
  const smart = resolveSmartSpec(p);

  // Batch-create so name-uniqueness + cycle detection see both groups
  // together; either both land or neither does.
  await createProxyGroups(
    ctx.profileId,
    [
      smartPoolGroupInput(poolName, smart),
      {
        kind: 'raw',
        name: chainName,
        type: 'select',
        proxies: [p.backend],
        'dialer-proxy': poolName,
        notes: 'chained-proxy: pool-chain wrap',
      },
    ],
    ctx.configVersion,
  );

  await ctx.taxonomy.set(poolName, { kind: 'custom' }).catch(() => undefined);
  await ctx.taxonomy.set(chainName, { kind: 'custom' }).catch(() => undefined);

  const snap: PoolChainSnapshot = {
    poolName,
    poolMembers: [],
    chainName,
    backend: p.backend,
    smart,
  };
  return {
    data: { poolName, chainName, backend: p.backend, smart },
    // Reuse the pool-chain create/delete action pair so undo/redo flows
    // through the existing inverses (which now restore smart pools too).
    events: [
      {
        action: 'create-pool-chain',
        target: { kind: 'proxy-group', name: chainName },
        after: snap,
      },
    ] satisfies AuditEventInput[],
  };
};

const updateSmartPool: OpHandler = async (ctx, raw) => {
  const { poolName, ...spec } = UpdateSmartPoolPayload.parse(raw);
  const group = await getProxyGroupByName(ctx.profileId, poolName);
  if (!group) {
    throw ProblemDetailsError.notFound(`proxy-group "${poolName}" not found.`);
  }
  const before: SmartPoolSnapshot = {
    strategy: group.type === 'url-test' ? 'url-test' : 'fallback',
    filter: group.filter,
    testUrl: group.url ?? DEFAULT_TEST_URL,
    interval: group.interval ?? DEFAULT_INTERVAL,
  };
  const after = resolveSmartSpec(spec);

  await patchProxyGroup(
    ctx.profileId,
    group.id,
    {
      type: after.strategy,
      'include-all-proxies': true,
      // `null` clears the field — drop the filter when the pool goes region-less.
      filter: after.filter ?? null,
      url: after.testUrl,
      interval: after.interval,
    },
    ctx.configVersion,
  );

  return {
    data: { poolName, ...after },
    events: [
      {
        action: 'update-smart-pool',
        target: { kind: 'proxy-group', name: poolName },
        before,
        after,
      },
    ] satisfies AuditEventInput[],
  };
};

const deletePoolChain: OpHandler = async (ctx, raw) => {
  const { chainName } = DeletePoolChainPayload.parse(raw);
  const { backend, front: poolName } = await loadChainWrap(ctx.profileId, chainName);

  // The fronts pool — only delete if it's still around. We don't track
  // ownership; if the user shares the pool across chains they'd be in
  // trouble, but in practice each chain owns its own pool.
  const poolGroup = await getProxyGroupByName(ctx.profileId, poolName);
  const poolMembers = poolGroup?.proxies ?? [];
  // Capture the smart spec (if any) so undo can rebuild a filter pool
  // faithfully rather than as an empty manual pool.
  const smart: SmartPoolSnapshot | undefined =
    poolGroup?.['include-all-proxies'] === true
      ? {
          strategy: poolGroup.type === 'url-test' ? 'url-test' : 'fallback',
          filter: poolGroup.filter,
          testUrl: poolGroup.url ?? DEFAULT_TEST_URL,
          interval: poolGroup.interval ?? DEFAULT_INTERVAL,
        }
      : undefined;

  // Pre-validate together: if either is referenced by something outside the
  // chained-proxy bundle, refuse the whole teardown.
  const namesToDelete = poolGroup ? [chainName, poolName] : [chainName];
  await deleteProxyGroupsByName(ctx.profileId, namesToDelete, ctx.configVersion);

  await ctx.taxonomy.delete(chainName).catch(() => undefined);
  // Pool taxonomy is left alone — if the user previously tagged the pool
  // themselves we shouldn't blow that away.

  const snap: PoolChainSnapshot = { poolName, poolMembers, chainName, backend, smart };
  return {
    data: { chainName, poolName, backend },
    events: [
      {
        action: 'delete-pool-chain',
        target: { kind: 'proxy-group', name: chainName },
        before: snap,
      },
    ] satisfies AuditEventInput[],
  };
};

/* ─── Inverses ──────────────────────────────────────────────────────── */

const inverseSetFixedChain: InverseHandler = async (ctx, event) => {
  const after = event.after as FixedChainSnapshot | undefined;
  if (!after) throw ProblemDetailsError.unprocessable('Missing after-state.');
  const group = await getProxyGroupByName(ctx.profileId, after.chainName);
  if (!group) {
    throw ProblemDetailsError.conflict(`Chain "${after.chainName}" no longer exists.`);
  }
  await deleteProxyGroup(ctx.profileId, group.id, ctx.configVersion);
  await ctx.taxonomy.delete(after.chainName).catch(() => undefined);
  return {
    data: null,
    events: [
      {
        action: 'clear-chain',
        target: { kind: 'proxy-group', name: after.chainName },
        before: after,
      },
    ],
  };
};

const inverseClearChain: InverseHandler = async (ctx, event) => {
  const before = event.before as FixedChainSnapshot | undefined;
  if (!before) throw ProblemDetailsError.unprocessable('Missing before-state.');
  await createProxyGroup(
    ctx.profileId,
    {
      kind: 'raw',
      name: before.chainName,
      type: 'select',
      proxies: [before.backend],
      'dialer-proxy': before.front,
      notes: 'chained-proxy: fixed chain (restored via undo)',
    },
    ctx.configVersion,
  );
  await ctx.taxonomy.set(before.chainName, { kind: 'custom' }).catch(() => undefined);
  return {
    data: null,
    events: [
      {
        action: 'set-fixed-chain',
        target: { kind: 'proxy-group', name: before.chainName },
        after: before,
      },
    ],
  };
};

const inverseCreatePoolChain: InverseHandler = async (ctx, event) => {
  const after = event.after as PoolChainSnapshot | undefined;
  if (!after) throw ProblemDetailsError.unprocessable('Missing after-state.');
  await deleteProxyGroupsByName(
    ctx.profileId,
    [after.chainName, after.poolName],
    ctx.configVersion,
  );
  await ctx.taxonomy.delete(after.chainName).catch(() => undefined);
  await ctx.taxonomy.delete(after.poolName).catch(() => undefined);
  return {
    data: null,
    events: [
      {
        action: 'delete-pool-chain',
        target: { kind: 'proxy-group', name: after.chainName },
        before: after,
      },
    ],
  };
};

const inverseUpdatePoolMembers: InverseHandler = async (ctx, event) => {
  const before = event.before as { members: string[] } | undefined;
  const target = event.target;
  if (!before || target?.kind !== 'proxy-group') {
    throw ProblemDetailsError.unprocessable('Missing before-state or target.');
  }
  const group = await getProxyGroupByName(ctx.profileId, target.name);
  if (!group) {
    throw ProblemDetailsError.conflict(`Pool "${target.name}" no longer exists.`);
  }
  await patchProxyGroup(ctx.profileId, group.id, { proxies: before.members }, ctx.configVersion);
  return {
    data: null,
    events: [
      {
        action: 'update-pool-members',
        target,
        after: { members: before.members },
      },
    ],
  };
};

const inverseUpdateSmartPool: InverseHandler = async (ctx, event) => {
  const before = event.before as SmartPoolSnapshot | undefined;
  const target = event.target;
  if (!before || target?.kind !== 'proxy-group') {
    throw ProblemDetailsError.unprocessable('Missing before-state or target.');
  }
  const group = await getProxyGroupByName(ctx.profileId, target.name);
  if (!group) {
    throw ProblemDetailsError.conflict(`Pool "${target.name}" no longer exists.`);
  }
  await patchProxyGroup(
    ctx.profileId,
    group.id,
    {
      type: before.strategy,
      'include-all-proxies': true,
      filter: before.filter ?? null,
      url: before.testUrl,
      interval: before.interval,
    },
    ctx.configVersion,
  );
  return {
    data: null,
    events: [
      {
        action: 'update-smart-pool',
        target,
        after: before,
      },
    ],
  };
};

const inverseDeletePoolChain: InverseHandler = async (ctx, event) => {
  const before = event.before as PoolChainSnapshot | undefined;
  if (!before) throw ProblemDetailsError.unprocessable('Missing before-state.');
  const poolInput = before.smart
    ? {
        ...smartPoolGroupInput(before.poolName, before.smart),
        notes: 'chained-proxy: smart fronts pool (restored via undo)',
      }
    : {
        kind: 'raw' as const,
        name: before.poolName,
        type: 'select' as const,
        proxies: before.poolMembers,
        notes: 'chained-proxy: fronts pool (restored via undo)',
      };
  await createProxyGroups(
    ctx.profileId,
    [
      poolInput,
      {
        kind: 'raw',
        name: before.chainName,
        type: 'select',
        proxies: [before.backend],
        'dialer-proxy': before.poolName,
        notes: 'chained-proxy: pool-chain wrap (restored via undo)',
      },
    ],
    ctx.configVersion,
  );
  await ctx.taxonomy.set(before.poolName, { kind: 'custom' }).catch(() => undefined);
  await ctx.taxonomy.set(before.chainName, { kind: 'custom' }).catch(() => undefined);
  return {
    data: null,
    events: [
      {
        action: 'create-pool-chain',
        target: { kind: 'proxy-group', name: before.chainName },
        after: before,
      },
    ],
  };
};

/* ─── Diagnostic read (used by the page) ─────────────────────────────── */

/**
 * Enumerate the chained-proxy bundles currently in the hash. Recognises a
 * wrap group by having both `dialer-proxy` and exactly one `proxies` entry.
 * Pool chains are detected when the wrap's `dialer-proxy` points at another
 * group (the pool); fixed chains when it points at a name we don't manage.
 */
export async function summariseChains(profileId: string): Promise<{
  fixedChains: { chainName: string; backend: string; front: string }[];
  poolChains: {
    poolName: string;
    poolMembers: string[];
    chainName: string;
    backend: string;
    smart?: SmartPoolSnapshot;
  }[];
}> {
  const all = await listProxyGroups(profileId);
  const byName = new Map(all.map((g) => [g.name, g]));
  const fixedChains: { chainName: string; backend: string; front: string }[] = [];
  const poolChains: {
    poolName: string;
    poolMembers: string[];
    chainName: string;
    backend: string;
    smart?: SmartPoolSnapshot;
  }[] = [];
  for (const g of all) {
    const front = g['dialer-proxy'];
    const members = g.proxies ?? [];
    if (!front || members.length !== 1) continue;
    const pool = byName.get(front);
    // A pool is any managed group the wrap points at that isn't itself a
    // wrap. Manual pools carry `proxies`; smart pools carry
    // `include-all-proxies` + an optional filter (and so have no members).
    if (pool && !pool['dialer-proxy']) {
      const smart: SmartPoolSnapshot | undefined =
        pool['include-all-proxies'] === true
          ? {
              strategy: pool.type === 'url-test' ? 'url-test' : 'fallback',
              filter: pool.filter,
              testUrl: pool.url ?? DEFAULT_TEST_URL,
              interval: pool.interval ?? DEFAULT_INTERVAL,
            }
          : undefined;
      poolChains.push({
        poolName: pool.name,
        poolMembers: pool.proxies ?? [],
        chainName: g.name,
        backend: members[0],
        smart,
      });
    } else {
      fixedChains.push({ chainName: g.name, backend: members[0], front });
    }
  }
  return { fixedChains, poolChains };
}

/* ─── Export ────────────────────────────────────────────────────────── */

export const chainedProxyScenario: Scenario = {
  descriptor: {
    id: 'chained-proxy',
    title: '链式代理',
    description:
      '将后端节点包装到带 dialer-proxy 的 proxy-group，统一服务于 base 与聚合节点。',
    navHref: '/scenarios/chained-proxy',
  },
  ops: {
    'set-fixed-chain': setFixedChain,
    'clear-chain': clearChain,
    'create-pool-chain': createPoolChain,
    'create-smart-pool-chain': createSmartPoolChain,
    'update-pool-members': updatePoolMembers,
    'update-smart-pool': updateSmartPool,
    'delete-pool-chain': deletePoolChain,
  },
  inverses: {
    'set-fixed-chain': inverseSetFixedChain,
    'clear-chain': inverseClearChain,
    'create-pool-chain': inverseCreatePoolChain,
    'update-pool-members': inverseUpdatePoolMembers,
    'update-smart-pool': inverseUpdateSmartPool,
    'delete-pool-chain': inverseDeletePoolChain,
  },
};
