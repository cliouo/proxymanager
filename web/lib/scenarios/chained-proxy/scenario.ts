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
import type {
  AuditEventInput,
  InverseHandler,
  OpHandler,
  Scenario,
} from '../_shared/types';

/* ─── Payload schemas ───────────────────────────────────────────────── */

const NameSchema = z.string().min(1).max(128);

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

const DeletePoolChainPayload = z.object({
  chainName: NameSchema,
});

/* ─── Snapshot shapes ───────────────────────────────────────────────── */

interface FixedChainSnapshot {
  chainName: string;
  backend: string;
  front: string;
}

interface PoolChainSnapshot {
  poolName: string;
  poolMembers: string[];
  chainName: string;
  backend: string;
}

/* ─── Validation helpers ────────────────────────────────────────────── */

/**
 * Look up a chained-proxy "wrap" group by name and validate it has the
 * single-backend + dialer-proxy shape this scenario emits. The detection
 * is intentionally narrow — opening up to arbitrary user-edited groups
 * would let `clear-chain` blow away non-chain groups that happen to fit.
 */
async function loadChainWrap(
  chainName: string,
): Promise<{ group: ProxyGroup; backend: string; front: string }> {
  const group = await getProxyGroupByName(chainName);
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

/* ─── Op handlers ───────────────────────────────────────────────────── */

const setFixedChain: OpHandler = async (ctx, raw) => {
  const { backend, front, chainName } = SetFixedChainPayload.parse(raw);
  if (backend === front) {
    throw ProblemDetailsError.unprocessable('backend and front must differ.');
  }
  const name = chainName ?? defaultFixedChainName(front, backend);

  await createProxyGroup({
    kind: 'raw',
    name,
    type: 'select',
    proxies: [backend],
    'dialer-proxy': front,
    notes: 'chained-proxy: fixed chain',
  });

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
  const { group, backend, front } = await loadChainWrap(chainName);
  await deleteProxyGroup(group.id);
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
  await createProxyGroups([
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
  ]);

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

const updatePoolMembers: OpHandler = async (_ctx, raw) => {
  const { poolName, fronts } = UpdatePoolMembersPayload.parse(raw);
  if (new Set(fronts).size !== fronts.length) {
    throw ProblemDetailsError.unprocessable('Pool members must be unique.');
  }
  const group = await getProxyGroupByName(poolName);
  if (!group) {
    throw ProblemDetailsError.notFound(`proxy-group "${poolName}" not found.`);
  }
  const prevMembers = group.proxies ?? [];
  await patchProxyGroup(group.id, { proxies: fronts });
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

const deletePoolChain: OpHandler = async (ctx, raw) => {
  const { chainName } = DeletePoolChainPayload.parse(raw);
  const { backend, front: poolName } = await loadChainWrap(chainName);

  // The fronts pool — only delete if it's still around. We don't track
  // ownership; if the user shares the pool across chains they'd be in
  // trouble, but in practice each chain owns its own pool.
  const poolGroup = await getProxyGroupByName(poolName);
  const poolMembers = poolGroup?.proxies ?? [];

  // Pre-validate together: if either is referenced by something outside the
  // chained-proxy bundle, refuse the whole teardown.
  const namesToDelete = poolGroup ? [chainName, poolName] : [chainName];
  await deleteProxyGroupsByName(namesToDelete);

  await ctx.taxonomy.delete(chainName).catch(() => undefined);
  // Pool taxonomy is left alone — if the user previously tagged the pool
  // themselves we shouldn't blow that away.

  const snap: PoolChainSnapshot = { poolName, poolMembers, chainName, backend };
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
  const group = await getProxyGroupByName(after.chainName);
  if (!group) {
    throw ProblemDetailsError.conflict(`Chain "${after.chainName}" no longer exists.`);
  }
  await deleteProxyGroup(group.id);
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
  await createProxyGroup({
    kind: 'raw',
    name: before.chainName,
    type: 'select',
    proxies: [before.backend],
    'dialer-proxy': before.front,
    notes: 'chained-proxy: fixed chain (restored via undo)',
  });
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
  await deleteProxyGroupsByName([after.chainName, after.poolName]);
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

const inverseUpdatePoolMembers: InverseHandler = async (_ctx, event) => {
  const before = event.before as { members: string[] } | undefined;
  const target = event.target;
  if (!before || target?.kind !== 'proxy-group') {
    throw ProblemDetailsError.unprocessable('Missing before-state or target.');
  }
  const group = await getProxyGroupByName(target.name);
  if (!group) {
    throw ProblemDetailsError.conflict(`Pool "${target.name}" no longer exists.`);
  }
  await patchProxyGroup(group.id, { proxies: before.members });
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

const inverseDeletePoolChain: InverseHandler = async (ctx, event) => {
  const before = event.before as PoolChainSnapshot | undefined;
  if (!before) throw ProblemDetailsError.unprocessable('Missing before-state.');
  await createProxyGroups([
    {
      kind: 'raw',
      name: before.poolName,
      type: 'select',
      proxies: before.poolMembers,
      notes: 'chained-proxy: fronts pool (restored via undo)',
    },
    {
      kind: 'raw',
      name: before.chainName,
      type: 'select',
      proxies: [before.backend],
      'dialer-proxy': before.poolName,
      notes: 'chained-proxy: pool-chain wrap (restored via undo)',
    },
  ]);
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
export async function summariseChains(): Promise<{
  fixedChains: { chainName: string; backend: string; front: string }[];
  poolChains: {
    poolName: string;
    poolMembers: string[];
    chainName: string;
    backend: string;
  }[];
}> {
  const all = await listProxyGroups();
  const byName = new Map(all.map((g) => [g.name, g]));
  const fixedChains: { chainName: string; backend: string; front: string }[] = [];
  const poolChains: {
    poolName: string;
    poolMembers: string[];
    chainName: string;
    backend: string;
  }[] = [];
  for (const g of all) {
    const front = g['dialer-proxy'];
    const members = g.proxies ?? [];
    if (!front || members.length !== 1) continue;
    const pool = byName.get(front);
    if (pool && (pool.proxies?.length ?? 0) > 0 && !pool['dialer-proxy']) {
      poolChains.push({
        poolName: pool.name,
        poolMembers: pool.proxies ?? [],
        chainName: g.name,
        backend: members[0],
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
    title: 'Chained proxies',
    description:
      'Wrap backends in proxy-groups with dialer-proxy so chains work even when the backend comes from a subscription.',
    navHref: '/scenarios/chained-proxy',
  },
  ops: {
    'set-fixed-chain': setFixedChain,
    'clear-chain': clearChain,
    'create-pool-chain': createPoolChain,
    'update-pool-members': updatePoolMembers,
    'delete-pool-chain': deletePoolChain,
  },
  inverses: {
    'set-fixed-chain': inverseSetFixedChain,
    'clear-chain': inverseClearChain,
    'create-pool-chain': inverseCreatePoolChain,
    'update-pool-members': inverseUpdatePoolMembers,
    'delete-pool-chain': inverseDeletePoolChain,
  },
};
