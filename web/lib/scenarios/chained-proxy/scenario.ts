/**
 * `chained-proxy` — Mihomo proxy chaining via wrapper proxy-groups.
 *
 * Why groups not `dialer-proxy` on individual proxies: after P4 the
 * "real" proxies are merged in from collections at render time. They
 * don't have a literal entry in base.yaml's `proxies:` section that we
 * could attach a field to. Wrapper groups (which live in
 * `proxy-groups:` and reference the proxy by name) work regardless of
 * where the underlying proxy comes from — Mihomo resolves the
 * references against the fully-expanded config.
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
 * detection refuses chains that would loop.
 */

import { z } from 'zod';
import { isMap, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
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

/* ─── YAML AST helpers ──────────────────────────────────────────────── */

function asString(node: unknown): string | undefined {
  if (node && isScalar(node) && typeof node.value === 'string') return node.value;
  return undefined;
}

function groupsSeq(doc: Document): YAMLSeq | null {
  const n = doc.get('proxy-groups', true);
  return isSeq(n) ? (n as YAMLSeq) : null;
}

function findGroupByName(doc: Document, name: string): YAMLMap | null {
  const gs = groupsSeq(doc);
  if (!gs) return null;
  for (const item of gs.items) {
    if (isMap(item) && asString((item as YAMLMap).get('name', true)) === name) {
      return item as YAMLMap;
    }
  }
  return null;
}

function findGroupIndex(doc: Document, name: string): number {
  const gs = groupsSeq(doc);
  if (!gs) return -1;
  return gs.items.findIndex(
    (i) => isMap(i) && asString((i as YAMLMap).get('name', true)) === name,
  );
}

function getMembers(group: YAMLMap): string[] {
  const node = group.get('proxies', true);
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === 'string') out.push(item.value);
  }
  return out;
}

function setMembers(group: YAMLMap, members: string[]): void {
  group.set('proxies', members);
}

function ensureGroupsSeq(doc: Document): YAMLSeq {
  let gs = groupsSeq(doc);
  if (!gs) {
    doc.set('proxy-groups', []);
    gs = groupsSeq(doc);
    if (!gs) throw ProblemDetailsError.internal('Failed to materialise proxy-groups section.');
  }
  return gs;
}

function appendGroup(doc: Document, group: { name: string; type: string; proxies: string[]; 'dialer-proxy'?: string }): void {
  ensureGroupsSeq(doc).add(group);
}

function deleteGroupByName(doc: Document, name: string): boolean {
  const gs = groupsSeq(doc);
  if (!gs) return false;
  const idx = gs.items.findIndex(
    (i) => isMap(i) && asString((i as YAMLMap).get('name', true)) === name,
  );
  if (idx < 0) return false;
  gs.delete(idx);
  return true;
}

/* ─── Validation ────────────────────────────────────────────────────── */

function ensureGroupNameAvailable(doc: Document, name: string): void {
  if (findGroupIndex(doc, name) >= 0) {
    throw ProblemDetailsError.conflict(`proxy-group "${name}" already exists.`);
  }
}

/**
 * Walk the dialer-proxy edge set with the proposed new wrapper group
 * applied and refuse if any node revisits itself. References that point at
 * names not present in base.yaml (collection-supplied nodes) terminate the
 * walk — they're black-boxes from this scenario's perspective.
 */
function ensureNoCycle(doc: Document, newWrapper: { name: string; backend: string; dialerProxy: string }): void {
  const edges = new Map<string, string>();
  const gs = groupsSeq(doc);
  if (gs) {
    for (const item of gs.items) {
      if (!isMap(item)) continue;
      const n = asString((item as YAMLMap).get('name', true));
      const dp = asString((item as YAMLMap).get('dialer-proxy', true));
      if (n && dp) edges.set(n, dp);
    }
  }
  edges.set(newWrapper.name, newWrapper.dialerProxy);

  const visited = new Set<string>();
  let cur: string | undefined = newWrapper.name;
  while (cur) {
    if (visited.has(cur)) {
      throw ProblemDetailsError.unprocessable(`Cycle detected in chain graph at "${cur}".`);
    }
    visited.add(cur);
    cur = edges.get(cur);
  }
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

  const { result: events } = await ctx.base.withDocument((doc) => {
    ensureGroupNameAvailable(doc, name);
    ensureNoCycle(doc, { name, backend, dialerProxy: front });

    appendGroup(doc, {
      name,
      type: 'select',
      proxies: [backend],
      'dialer-proxy': front,
    });

    const snap: FixedChainSnapshot = { chainName: name, backend, front };
    return [
      {
        action: 'set-fixed-chain',
        target: { kind: 'proxy-group', name },
        after: snap,
      },
    ] satisfies AuditEventInput[];
  });

  await ctx.taxonomy.set(name, { kind: 'custom' }).catch(() => undefined);
  return { data: { chainName: name, backend, front }, events };
};

const clearChain: OpHandler = async (ctx, raw) => {
  const { chainName } = ClearChainPayload.parse(raw);

  const { result } = await ctx.base.withDocument((doc) => {
    const group = findGroupByName(doc, chainName);
    if (!group) {
      throw ProblemDetailsError.notFound(`Chain group "${chainName}" not found.`);
    }
    const front = asString(group.get('dialer-proxy', true));
    const members = getMembers(group);
    if (!front || members.length !== 1) {
      throw ProblemDetailsError.unprocessable(
        `Group "${chainName}" doesn't look like a fixed chain (need dialer-proxy + exactly one member).`,
      );
    }
    deleteGroupByName(doc, chainName);

    const snap: FixedChainSnapshot = { chainName, backend: members[0], front };
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
  });

  await ctx.taxonomy.delete(chainName).catch(() => undefined);
  return { data: result.data, events: result.events };
};

const createPoolChain: OpHandler = async (ctx, raw) => {
  const { backend, fronts, poolName: poolNameOverride, chainName: chainNameOverride } =
    CreatePoolChainPayload.parse(raw);

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

  const { result: events } = await ctx.base.withDocument((doc) => {
    ensureGroupNameAvailable(doc, poolName);
    ensureGroupNameAvailable(doc, chainName);
    ensureNoCycle(doc, { name: chainName, backend, dialerProxy: poolName });

    appendGroup(doc, { name: poolName, type: 'select', proxies: fronts });
    appendGroup(doc, {
      name: chainName,
      type: 'select',
      proxies: [backend],
      'dialer-proxy': poolName,
    });

    const snap: PoolChainSnapshot = {
      poolName,
      poolMembers: fronts,
      chainName,
      backend,
    };
    return [
      {
        action: 'create-pool-chain',
        target: { kind: 'proxy-group', name: chainName },
        after: snap,
      },
    ] satisfies AuditEventInput[];
  });

  await ctx.taxonomy.set(poolName, { kind: 'custom' }).catch(() => undefined);
  await ctx.taxonomy.set(chainName, { kind: 'custom' }).catch(() => undefined);

  return { data: { poolName, chainName, backend, fronts }, events };
};

const updatePoolMembers: OpHandler = async (ctx, raw) => {
  const { poolName, fronts } = UpdatePoolMembersPayload.parse(raw);
  if (new Set(fronts).size !== fronts.length) {
    throw ProblemDetailsError.unprocessable('Pool members must be unique.');
  }

  const { result: events } = await ctx.base.withDocument((doc) => {
    const group = findGroupByName(doc, poolName);
    if (!group) {
      throw ProblemDetailsError.notFound(`proxy-group "${poolName}" not found.`);
    }
    const prevMembers = getMembers(group);
    setMembers(group, fronts);

    return [
      {
        action: 'update-pool-members',
        target: { kind: 'proxy-group', name: poolName },
        before: { members: prevMembers },
        after: { members: fronts },
      },
    ] satisfies AuditEventInput[];
  });

  return { data: { poolName, fronts }, events };
};

const deletePoolChain: OpHandler = async (ctx, raw) => {
  const { chainName } = DeletePoolChainPayload.parse(raw);

  const { result } = await ctx.base.withDocument((doc) => {
    const chainGroup = findGroupByName(doc, chainName);
    if (!chainGroup) {
      throw ProblemDetailsError.notFound(`Chain group "${chainName}" not found.`);
    }
    const poolName = asString(chainGroup.get('dialer-proxy', true));
    const backendList = getMembers(chainGroup);
    if (!poolName || backendList.length !== 1) {
      throw ProblemDetailsError.unprocessable(
        `Group "${chainName}" doesn't look like a pool chain.`,
      );
    }
    const backend = backendList[0];

    // The fronts pool — only delete if it's actually a group we own (i.e.
    // referenced exclusively by this chain). We don't track ownership
    // explicitly; for now we always delete it. If users share pools across
    // multiple chains they'll need to recreate.
    const poolGroup = findGroupByName(doc, poolName);
    const poolMembers = poolGroup ? getMembers(poolGroup) : [];

    deleteGroupByName(doc, chainName);
    if (poolGroup) deleteGroupByName(doc, poolName);

    const snap: PoolChainSnapshot = {
      poolName,
      poolMembers,
      chainName,
      backend,
    };
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
  });

  await ctx.taxonomy.delete(chainName).catch(() => undefined);
  // Pool taxonomy is left alone — if the user previously tagged the pool
  // themselves we shouldn't blow that away.

  return { data: result.data, events: result.events };
};

/* ─── Inverses ──────────────────────────────────────────────────────── */

const inverseSetFixedChain: InverseHandler = async (ctx, event) => {
  const after = event.after as FixedChainSnapshot | undefined;
  if (!after) throw ProblemDetailsError.unprocessable('Missing after-state.');
  await ctx.base.withDocument((doc) => {
    if (!deleteGroupByName(doc, after.chainName)) {
      throw ProblemDetailsError.conflict(`Chain "${after.chainName}" no longer exists.`);
    }
  });
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
  await ctx.base.withDocument((doc) => {
    ensureGroupNameAvailable(doc, before.chainName);
    appendGroup(doc, {
      name: before.chainName,
      type: 'select',
      proxies: [before.backend],
      'dialer-proxy': before.front,
    });
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
  await ctx.base.withDocument((doc) => {
    deleteGroupByName(doc, after.chainName);
    deleteGroupByName(doc, after.poolName);
  });
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
  await ctx.base.withDocument((doc) => {
    const group = findGroupByName(doc, target.name);
    if (!group) {
      throw ProblemDetailsError.conflict(`Pool "${target.name}" no longer exists.`);
    }
    setMembers(group, before.members);
  });
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
  await ctx.base.withDocument((doc) => {
    ensureGroupNameAvailable(doc, before.poolName);
    ensureGroupNameAvailable(doc, before.chainName);
    appendGroup(doc, { name: before.poolName, type: 'select', proxies: before.poolMembers });
    appendGroup(doc, {
      name: before.chainName,
      type: 'select',
      proxies: [before.backend],
      'dialer-proxy': before.poolName,
    });
  });
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

/* ─── Export ────────────────────────────────────────────────────────── */

export const chainedProxyScenario: Scenario = {
  descriptor: {
    id: 'chained-proxy',
    title: 'Chained proxies',
    description:
      'Wrap backends in proxy-groups with dialer-proxy so chains work even when the backend comes from a collection.',
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
