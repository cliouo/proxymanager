/**
 * `chained-proxy` — express Mihomo proxy chaining via the `dialer-proxy`
 * field.
 *
 * Two flavours, both implemented with the same low-level YAML field:
 *
 *  Fixed chain
 *    On backend node B, set `dialer-proxy: F`. Traffic to B routes
 *    client → F → B → exit. One-to-one mapping. Pure field edit.
 *
 *  Pool chain
 *    Create a `select`-type proxy-group named e.g. "pool-via-B" whose
 *    members are candidate frontends [F1..Fn]. Set `dialer-proxy: pool-via-B`
 *    on B. Switching the pool's selection in Clash UI swaps which F is
 *    currently used as the front, without rewriting YAML.
 *
 * Mutating ops:
 *   - set-fixed-chain     B + F → set dialer-proxy=F on B
 *   - clear-chain         B → remove dialer-proxy from B
 *   - create-pool-chain   B + poolName + [F1..Fn] → new select group + set dialer-proxy=poolName on B
 *   - update-pool-members poolName + [F1..Fn] → replace pool group's proxies list
 *   - delete-pool-chain   poolName → clear dialer-proxy on every backend pointing here, delete the group
 *
 * Each op carries enough state in before/after to be inverted by /history.
 */

import { z } from 'zod';
import { isMap, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import type {
  AuditEventInput,
  InverseHandler,
  OpContext,
  OpHandler,
  OpResult,
  Scenario,
} from '../_shared/types';

/* ─── Payload schemas ───────────────────────────────────────────────── */

const NameSchema = z.string().min(1).max(128);

const SetFixedChainPayload = z.object({
  backend: NameSchema,
  front: NameSchema,
});

const ClearChainPayload = z.object({
  backend: NameSchema,
});

const CreatePoolChainPayload = z.object({
  poolName: NameSchema,
  backend: NameSchema,
  fronts: z.array(NameSchema).min(1).max(64),
});

const UpdatePoolMembersPayload = z.object({
  poolName: NameSchema,
  fronts: z.array(NameSchema).min(1).max(64),
});

const DeletePoolChainPayload = z.object({
  poolName: NameSchema,
});

/* ─── Snapshot shapes (audit before/after) ──────────────────────────── */

interface FixedChainSnapshot {
  backend: string;
  dialerProxy: string | null;
}

interface PoolGroupSnapshot {
  poolName: string;
  type: string;
  members: string[];
  /** Backends that had dialer-proxy=poolName at the time of the snapshot. */
  affectedBackends: Array<{ name: string; prevDialerProxy: string | null }>;
}

/* ─── YAML AST helpers (Document API only — preserves comments/order) ── */

function asString(node: unknown): string | undefined {
  if (node && isScalar(node) && typeof node.value === 'string') return node.value;
  return undefined;
}

function findEntryByName(seq: YAMLSeq | null, name: string): YAMLMap | null {
  if (!seq) return null;
  for (const item of seq.items) {
    if (isMap(item) && asString(item.get('name', true)) === name) {
      return item as YAMLMap;
    }
  }
  return null;
}

function proxiesSeq(doc: Document): YAMLSeq | null {
  const n = doc.get('proxies', true);
  return isSeq(n) ? (n as YAMLSeq) : null;
}

function groupsSeq(doc: Document): YAMLSeq | null {
  const n = doc.get('proxy-groups', true);
  return isSeq(n) ? (n as YAMLSeq) : null;
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

function findAllProxyNames(doc: Document): Set<string> {
  const out = new Set<string>();
  const ps = proxiesSeq(doc);
  if (ps) for (const item of ps.items) {
    if (isMap(item)) {
      const n = asString(item.get('name', true));
      if (n) out.add(n);
    }
  }
  return out;
}

function findAllGroupNames(doc: Document): Set<string> {
  const out = new Set<string>();
  const gs = groupsSeq(doc);
  if (gs) for (const item of gs.items) {
    if (isMap(item)) {
      const n = asString(item.get('name', true));
      if (n) out.add(n);
    }
  }
  return out;
}

/* ─── Validation helpers ────────────────────────────────────────────── */

function ensureProxyExists(doc: Document, name: string): void {
  if (!findAllProxyNames(doc).has(name)) {
    throw ProblemDetailsError.unprocessable(
      `Proxy "${name}" not found in base.yaml.`,
    );
  }
}

function ensureNameAvailable(doc: Document, name: string, kind: 'proxy-group'): void {
  if (kind === 'proxy-group' && findAllGroupNames(doc).has(name)) {
    throw ProblemDetailsError.conflict(
      `proxy-group "${name}" already exists.`,
    );
  }
  if (findAllProxyNames(doc).has(name)) {
    throw ProblemDetailsError.conflict(
      `proxy "${name}" already exists; can't reuse the name for a ${kind}.`,
    );
  }
}

/**
 * Refuse circular chains. Walks the dialer-proxy graph from `backend`
 * applying the proposed change and ensures no node revisits itself.
 */
function ensureNoCycle(
  doc: Document,
  backend: string,
  proposedDialerProxy: string,
): void {
  // Snapshot current dialer-proxy edges, then apply the proposed override.
  const edges = new Map<string, string>();
  const ps = proxiesSeq(doc);
  if (ps) {
    for (const item of ps.items) {
      if (!isMap(item)) continue;
      const n = asString(item.get('name', true));
      const dp = asString(item.get('dialer-proxy', true));
      if (n && dp) edges.set(n, dp);
    }
  }
  edges.set(backend, proposedDialerProxy);

  // dialer-proxy can point at a proxy-group; groups don't have their own
  // dialer-proxy (we don't set it through this scenario), so the walk ends
  // when we hit a group name. Still treat groups as terminal nodes for
  // safety.
  const groupNames = findAllGroupNames(doc);

  const visited = new Set<string>();
  let cur = backend;
  while (cur) {
    if (visited.has(cur)) {
      throw ProblemDetailsError.unprocessable(
        `Cycle detected in dialer-proxy graph at "${cur}".`,
      );
    }
    visited.add(cur);
    const next = edges.get(cur);
    if (!next) break;
    if (groupNames.has(next)) break;
    cur = next;
  }
}

/* ─── Op handlers ───────────────────────────────────────────────────── */

const setFixedChain: OpHandler = async (ctx, raw) => {
  const { backend, front } = SetFixedChainPayload.parse(raw);
  if (backend === front) {
    throw ProblemDetailsError.unprocessable('backend and front must differ.');
  }

  const { result: events } = await ctx.base.withDocument((doc) => {
    ensureProxyExists(doc, backend);
    if (!findAllProxyNames(doc).has(front) && !findAllGroupNames(doc).has(front)) {
      throw ProblemDetailsError.unprocessable(
        `Front "${front}" must be an existing proxy or proxy-group.`,
      );
    }
    ensureNoCycle(doc, backend, front);

    const entry = findEntryByName(proxiesSeq(doc), backend);
    if (!entry) {
      throw ProblemDetailsError.unprocessable(`Backend "${backend}" not found.`);
    }
    const prev = asString(entry.get('dialer-proxy', true)) ?? null;
    entry.set('dialer-proxy', front);

    const before: FixedChainSnapshot = { backend, dialerProxy: prev };
    const after: FixedChainSnapshot = { backend, dialerProxy: front };
    return [
      {
        action: 'set-fixed-chain',
        target: { kind: 'proxy', name: backend },
        before,
        after,
      },
    ] satisfies AuditEventInput[];
  });

  return { data: { backend, front }, events };
};

const clearChain: OpHandler = async (ctx, raw) => {
  const { backend } = ClearChainPayload.parse(raw);

  const { result } = await ctx.base.withDocument((doc) => {
    const entry = findEntryByName(proxiesSeq(doc), backend);
    if (!entry) {
      throw ProblemDetailsError.unprocessable(`Backend "${backend}" not found.`);
    }
    const prev = asString(entry.get('dialer-proxy', true));
    if (!prev) {
      return {
        data: { backend, cleared: false },
        events: [] satisfies AuditEventInput[],
      };
    }
    entry.delete('dialer-proxy');

    const before: FixedChainSnapshot = { backend, dialerProxy: prev };
    const after: FixedChainSnapshot = { backend, dialerProxy: null };
    return {
      data: { backend, cleared: true, prev },
      events: [
        {
          action: 'clear-chain',
          target: { kind: 'proxy', name: backend },
          before,
          after,
        },
      ] satisfies AuditEventInput[],
    };
  });
  return { data: result.data, events: result.events };
};

const createPoolChain: OpHandler = async (ctx, raw) => {
  const { poolName, backend, fronts } = CreatePoolChainPayload.parse(raw);

  if (fronts.includes(backend)) {
    throw ProblemDetailsError.unprocessable(
      `Backend "${backend}" cannot also appear as a front in the same pool.`,
    );
  }
  if (new Set(fronts).size !== fronts.length) {
    throw ProblemDetailsError.unprocessable('Pool fronts must be unique.');
  }

  const { result: events } = await ctx.base.withDocument((doc) => {
    ensureProxyExists(doc, backend);
    for (const f of fronts) {
      if (!findAllProxyNames(doc).has(f) && !findAllGroupNames(doc).has(f)) {
        throw ProblemDetailsError.unprocessable(
          `Pool member "${f}" must be an existing proxy or proxy-group.`,
        );
      }
    }
    ensureNameAvailable(doc, poolName, 'proxy-group');
    ensureNoCycle(doc, backend, poolName);

    // 1) Append new group.
    const gs = groupsSeq(doc);
    if (!gs) {
      throw ProblemDetailsError.unprocessable(
        'base.yaml has no proxy-groups section to extend.',
      );
    }
    gs.add({ name: poolName, type: 'select', proxies: fronts });

    // 2) Set dialer-proxy on backend.
    const entry = findEntryByName(proxiesSeq(doc), backend);
    if (!entry) throw ProblemDetailsError.internal('Backend disappeared mid-mutation.');
    const prev = asString(entry.get('dialer-proxy', true)) ?? null;
    entry.set('dialer-proxy', poolName);

    const snap: PoolGroupSnapshot = {
      poolName,
      type: 'select',
      members: fronts,
      affectedBackends: [{ name: backend, prevDialerProxy: prev }],
    };
    return [
      {
        action: 'create-pool-chain',
        target: { kind: 'proxy-group', name: poolName },
        after: snap,
      },
    ] satisfies AuditEventInput[];
  });

  // Tag taxonomy so future scenarios (regional-groups, platform-groups) can
  // exclude chain pools from their own listings.
  await ctx.taxonomy.set(poolName, { kind: 'custom' });

  return { data: { poolName, backend, fronts }, events };
};

const updatePoolMembers: OpHandler = async (ctx, raw) => {
  const { poolName, fronts } = UpdatePoolMembersPayload.parse(raw);
  if (new Set(fronts).size !== fronts.length) {
    throw ProblemDetailsError.unprocessable('Pool members must be unique.');
  }

  const { result: events } = await ctx.base.withDocument((doc) => {
    const group = findEntryByName(groupsSeq(doc), poolName);
    if (!group) {
      throw ProblemDetailsError.notFound(`proxy-group "${poolName}" not found.`);
    }
    for (const f of fronts) {
      if (!findAllProxyNames(doc).has(f) && !findAllGroupNames(doc).has(f)) {
        throw ProblemDetailsError.unprocessable(
          `Pool member "${f}" must be an existing proxy or proxy-group.`,
        );
      }
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
  const { poolName } = DeletePoolChainPayload.parse(raw);

  const { result } = await ctx.base.withDocument((doc) => {
    const gs = groupsSeq(doc);
    const ps = proxiesSeq(doc);
    if (!gs) throw ProblemDetailsError.unprocessable('No proxy-groups section.');
    const idx = gs.items.findIndex(
      (i) => isMap(i) && asString((i as YAMLMap).get('name', true)) === poolName,
    );
    if (idx < 0) {
      throw ProblemDetailsError.notFound(`proxy-group "${poolName}" not found.`);
    }
    const group = gs.items[idx] as YAMLMap;
    const prevMembers = getMembers(group);
    const prevType = asString(group.get('type', true)) ?? 'select';

    // Clear dialer-proxy on every backend pointing at this pool.
    const affected: Array<{ name: string; prevDialerProxy: string | null }> = [];
    if (ps) {
      for (const item of ps.items) {
        if (!isMap(item)) continue;
        if (asString((item as YAMLMap).get('dialer-proxy', true)) === poolName) {
          const name = asString((item as YAMLMap).get('name', true));
          if (name) {
            affected.push({ name, prevDialerProxy: poolName });
            (item as YAMLMap).delete('dialer-proxy');
          }
        }
      }
    }

    gs.delete(idx);

    const snap: PoolGroupSnapshot = {
      poolName,
      type: prevType,
      members: prevMembers,
      affectedBackends: affected,
    };
    return {
      data: { poolName, affectedBackends: affected.map((a) => a.name) },
      events: [
        {
          action: 'delete-pool-chain',
          target: { kind: 'proxy-group', name: poolName },
          before: snap,
        },
      ] satisfies AuditEventInput[],
    };
  });

  // Clean up taxonomy tag if present.
  await ctx.taxonomy.delete(poolName).catch(() => undefined);

  return { data: result.data, events: result.events };
};

/* ─── Inverse handlers ──────────────────────────────────────────────── */

const inverseSetFixedChain: InverseHandler = async (ctx, event) => {
  const before = event.before as FixedChainSnapshot | undefined;
  if (!before) throw ProblemDetailsError.unprocessable('Missing before-state.');
  await ctx.base.withDocument((doc) => {
    const entry = findEntryByName(proxiesSeq(doc), before.backend);
    if (!entry) {
      throw ProblemDetailsError.conflict(
        `Backend "${before.backend}" no longer exists.`,
      );
    }
    if (before.dialerProxy) {
      entry.set('dialer-proxy', before.dialerProxy);
    } else {
      entry.delete('dialer-proxy');
    }
  });
  return {
    data: null,
    events: [
      {
        action: before.dialerProxy ? 'set-fixed-chain' : 'clear-chain',
        target: { kind: 'proxy', name: before.backend },
        after: before,
      },
    ],
  };
};

const inverseClearChain: InverseHandler = async (ctx, event) => {
  const before = event.before as FixedChainSnapshot | undefined;
  if (!before || !before.dialerProxy) {
    throw ProblemDetailsError.unprocessable('Missing prev dialer-proxy.');
  }
  await ctx.base.withDocument((doc) => {
    const entry = findEntryByName(proxiesSeq(doc), before.backend);
    if (!entry) {
      throw ProblemDetailsError.conflict(`Backend "${before.backend}" no longer exists.`);
    }
    entry.set('dialer-proxy', before.dialerProxy as string);
  });
  return {
    data: null,
    events: [
      {
        action: 'set-fixed-chain',
        target: { kind: 'proxy', name: before.backend },
        after: { backend: before.backend, dialerProxy: before.dialerProxy },
      },
    ],
  };
};

const inverseCreatePoolChain: InverseHandler = async (ctx, event) => {
  const after = event.after as PoolGroupSnapshot | undefined;
  if (!after) throw ProblemDetailsError.unprocessable('Missing after-state.');
  await ctx.base.withDocument((doc) => {
    // Remove the pool group.
    const gs = groupsSeq(doc);
    if (gs) {
      const idx = gs.items.findIndex(
        (i) => isMap(i) && asString((i as YAMLMap).get('name', true)) === after.poolName,
      );
      if (idx >= 0) gs.delete(idx);
    }
    // Restore each affected backend's prior dialer-proxy.
    for (const b of after.affectedBackends) {
      const entry = findEntryByName(proxiesSeq(doc), b.name);
      if (!entry) continue;
      if (b.prevDialerProxy) entry.set('dialer-proxy', b.prevDialerProxy);
      else entry.delete('dialer-proxy');
    }
  });
  await ctx.taxonomy.delete(after.poolName).catch(() => undefined);
  return {
    data: null,
    events: [
      {
        action: 'delete-pool-chain',
        target: { kind: 'proxy-group', name: after.poolName },
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
    const group = findEntryByName(groupsSeq(doc), target.name);
    if (!group) {
      throw ProblemDetailsError.conflict(`proxy-group "${target.name}" no longer exists.`);
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
  const before = event.before as PoolGroupSnapshot | undefined;
  if (!before) throw ProblemDetailsError.unprocessable('Missing before-state.');
  await ctx.base.withDocument((doc) => {
    const gs = groupsSeq(doc);
    if (!gs) throw ProblemDetailsError.unprocessable('No proxy-groups section.');
    if (findAllGroupNames(doc).has(before.poolName)) {
      throw ProblemDetailsError.conflict(
        `proxy-group "${before.poolName}" already exists; refuse to recreate.`,
      );
    }
    gs.add({ name: before.poolName, type: before.type, proxies: before.members });
    for (const b of before.affectedBackends) {
      const entry = findEntryByName(proxiesSeq(doc), b.name);
      if (!entry) continue;
      entry.set('dialer-proxy', before.poolName);
    }
  });
  await ctx.taxonomy.set(before.poolName, { kind: 'custom' }).catch(() => undefined);
  return {
    data: null,
    events: [
      {
        action: 'create-pool-chain',
        target: { kind: 'proxy-group', name: before.poolName },
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
      'Set dialer-proxy on backends to chain traffic through a fixed front, or via a selectable pool of fronts.',
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
