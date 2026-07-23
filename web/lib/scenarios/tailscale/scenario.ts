/**
 * `tailscale` — one-click tailnet access via fixed Mihomo's embedded tsnet
 * outbound (`type: tailscale`).
 *
 * Philosophy: generator, not a config layer. The scenario mints ordinary
 * artifacts — a base-literal tailscale proxy (static credentialed node →
 * base.yaml `proxies:`, same path as any hand-written node), a single-member
 * `select` proxy-group, and IP-CIDR rules pointing at it (the whole CGNAT
 * range 100.64.0.0/10 = the tailnet) — then hands ownership to the normal
 * /base, proxy-groups and rules modules. Management re-detects the artifacts
 * by shape (cf. chained-proxy's loadChainWrap); the scenario owns no state,
 * so nothing can drift.
 *
 * Write order is a hard constraint: node → (group + rules). Every commit
 * preflights the fully rendered config, so a group whose member doesn't exist
 * yet — or a rule whose policy group is missing — would be refused. Group and
 * rules land in ONE preflightAndCommitProfileChanges commit, so there is no
 * half-created window between them; the base write is its own commit (no
 * cross-store transaction exists). `enable`/`disable` are reconciles: each
 * artifact is created/removed only if present, so a mid-write race heals on
 * re-run, and a user who hand-built half the shape is adopted, not fought.
 *
 * NOTE: ctx.configVersion / ctx.rules are captured before the handler runs;
 * after this scenario's base write bumps config:version they would 412. The
 * group+rules commit therefore goes through preflightAndCommitProfileChanges
 * directly with a fresh planning version.
 *
 * Credential rule: the auth-key never enters audit snapshots, op results or
 * error messages — snapshots carry `hasAuthKey` instead. The price: undoing
 * a `disable` restores the node WITHOUT its auth-key (UI warns to re-enter),
 * and `update-auth-key` is not undoable at all.
 */

import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { z } from 'zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';
import {
  ensureValidAnchorAndPolicy,
  generateRuleId,
  loadParsedBase,
  nowSeconds,
} from '@/lib/services/rulesService';
import {
  generateProxyGroupId,
  getProxyGroupByName,
  listProxyGroups,
} from '@/lib/services/proxyGroupService';
import { ProxyGroupCreateSchema, RuleCreateSchema, type ProxyGroup, type Rule } from '@/schemas';
import type { AuditEventInput, InverseHandler, OpContext, OpHandler, Scenario } from '../_shared/types';

/* ─── Constants ─────────────────────────────────────────────────────── */

/** The whole CGNAT range — every tailnet address lives in it. */
export const TAILNET_CIDR = '100.64.0.0/10';
const DEFAULT_GROUP_NAME = 'Tailscale';
const GROUP_NOTES = 'tailscale: tailnet access group';
const RULE_NOTE = 'tailscale: tailnet route';
const RANK_STEP = 10;

/* ─── Payload schemas ───────────────────────────────────────────────── */

const NameSchema = z.string().min(1).max(128);

const EnablePayload = z.object({
  /** Device name shown in the tailscale console. */
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'hostname 只能含字母、数字和中划线'),
  /** Reusable + tagged keys recommended; omitted = interactive login (headless-hostile). */
  authKey: z.string().trim().min(1).max(256).optional(),
  /** Unset = official SaaS; set for headscale. */
  controlUrl: z.string().trim().url().max(512).optional(),
  /** tsnet state persistence dir, relative to the client's working dir. */
  stateDir: z.string().trim().min(1).max(256).optional(),
  acceptRoutes: z.boolean().default(true),
  udp: z.boolean().default(true),
  exitNode: z.string().trim().min(1).max(128).optional(),
  nodeName: NameSchema.optional(),
  groupName: NameSchema.optional(),
  /** Rule anchor; defaults to the base's first anchor. */
  anchor: z.string().min(1).optional(),
  /** Subnet-router ranges that also need routing into the tailnet. */
  extraCidrs: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
});

const UpdateAuthKeyPayload = z.object({
  nodeName: NameSchema,
  authKey: z.string().trim().min(1).max(256),
});

const DisablePayload = z.object({
  /** Both optional — auto-detected when the profile has exactly one tailscale setup. */
  nodeName: NameSchema.optional(),
  groupName: NameSchema.optional(),
});

/* ─── Snapshot shapes ───────────────────────────────────────────────── */

/** Base-literal node with the credential replaced by a presence flag. */
export interface RedactedTailscaleNode {
  name: string;
  hostname?: string;
  controlUrl?: string;
  stateDir?: string;
  udp?: boolean;
  acceptRoutes?: boolean;
  ephemeral?: boolean;
  exitNode?: string;
  hasAuthKey: boolean;
}

interface EnableSnapshot {
  nodeName: string;
  groupName: string;
  anchor: string;
  created: { node: boolean; group: boolean; ruleIds: string[] };
  node: RedactedTailscaleNode;
  rules: Rule[];
}

interface DisableSnapshot {
  nodeName: string;
  groupName: string;
  node: RedactedTailscaleNode | null;
  group: ProxyGroup | null;
  rules: Rule[];
}

/* ─── YAML helpers (base.yaml `proxies:` sequence) ──────────────────── */

function getProxiesSeq(doc: Document): YAMLSeq | null {
  const node = doc.get('proxies', true);
  if (node == null) return null;
  if (!isSeq(node)) {
    throw ProblemDetailsError.unprocessable('base.yaml 的 proxies 段不是列表,无法安全修改。');
  }
  return node;
}

function findProxyMap(doc: Document, name: string): YAMLMap | null {
  const seq = getProxiesSeq(doc);
  if (!seq) return null;
  for (const item of seq.items) {
    if (isMap(item) && item.get('name') === name) return item;
  }
  return null;
}

function appendProxyMap(doc: Document, record: Record<string, unknown>): void {
  const seq = getProxiesSeq(doc);
  if (!seq) {
    doc.set('proxies', doc.createNode([record]));
    return;
  }
  seq.add(doc.createNode(record));
}

function removeProxyMap(doc: Document, name: string): boolean {
  const seq = getProxiesSeq(doc);
  if (!seq) return false;
  const idx = seq.items.findIndex((item) => isMap(item) && item.get('name') === name);
  if (idx < 0) return false;
  seq.items.splice(idx, 1);
  return true;
}

function redactNode(js: Record<string, unknown>): RedactedTailscaleNode {
  return {
    name: String(js.name ?? ''),
    hostname: typeof js.hostname === 'string' ? js.hostname : undefined,
    controlUrl: typeof js['control-url'] === 'string' ? js['control-url'] : undefined,
    stateDir: typeof js['state-dir'] === 'string' ? js['state-dir'] : undefined,
    udp: typeof js.udp === 'boolean' ? js.udp : undefined,
    acceptRoutes: typeof js['accept-routes'] === 'boolean' ? js['accept-routes'] : undefined,
    ephemeral: typeof js.ephemeral === 'boolean' ? js.ephemeral : undefined,
    exitNode: typeof js['exit-node'] === 'string' ? js['exit-node'] : undefined,
    hasAuthKey: typeof js['auth-key'] === 'string' && js['auth-key'].length > 0,
  };
}

/** Rebuild a base-literal record from a redacted snapshot — auth-key stays absent. */
function nodeRecordFromSnapshot(snap: RedactedTailscaleNode): Record<string, unknown> {
  return {
    name: snap.name,
    type: 'tailscale',
    ...(snap.hostname !== undefined ? { hostname: snap.hostname } : {}),
    ...(snap.controlUrl !== undefined ? { 'control-url': snap.controlUrl } : {}),
    ...(snap.stateDir !== undefined ? { 'state-dir': snap.stateDir } : {}),
    ...(snap.udp !== undefined ? { udp: snap.udp } : {}),
    ...(snap.acceptRoutes !== undefined ? { 'accept-routes': snap.acceptRoutes } : {}),
    ...(snap.ephemeral !== undefined ? { ephemeral: snap.ephemeral } : {}),
    ...(snap.exitNode !== undefined ? { 'exit-node': snap.exitNode } : {}),
  };
}

/* ─── Shape detection ───────────────────────────────────────────────── */

/**
 * Narrow check before this scenario deletes a group: exactly the shape
 * `enable` emits (single-member select of the node, no dialer-proxy). A
 * user-edited group falls outside and must be handled in the groups module —
 * deleting it here could blow away unrelated intent.
 */
function assertManagedTailscaleGroup(group: ProxyGroup, nodeName: string): void {
  const members = group.proxies ?? [];
  if (
    group.type !== 'select' ||
    group['dialer-proxy'] !== undefined ||
    members.length !== 1 ||
    members[0] !== nodeName
  ) {
    throw ProblemDetailsError.unprocessable(
      `策略组 "${group.name}" 不是本场景生成的形状(仅含节点 "${nodeName}" 的 select)——请到策略组页面手动处理。`,
    );
  }
}

/**
 * Everything outside the scenario's own artifacts that pins them down. Run
 * BEFORE any deletion so `disable` refuses up-front instead of stranding a
 * half-torn-down profile (there is no cross-store rollback).
 */
function scanForeignReferences(
  groups: ProxyGroup[],
  rules: Rule[],
  nodeName: string,
  groupName: string,
): string[] {
  const refs: string[] = [];
  for (const g of groups) {
    if (g.name === groupName) continue;
    const members = g.proxies ?? [];
    if (members.includes(nodeName)) refs.push(`策略组 "${g.name}" 引用了节点`);
    if (members.includes(groupName)) refs.push(`策略组 "${g.name}" 引用了组`);
    if (g['dialer-proxy'] === nodeName || g['dialer-proxy'] === groupName) {
      refs.push(`策略组 "${g.name}" 的 dialer-proxy 引用`);
    }
  }
  for (const r of rules) {
    if (r.policy === nodeName) refs.push(`规则 ${r.id} 直接指向节点`);
  }
  return refs;
}

async function nextGroupRank(profileId: string): Promise<number> {
  const all = await listProxyGroups(profileId);
  let max = 0;
  for (const g of all) if (g.rank > max) max = g.rank;
  return max + RANK_STEP;
}

function invalidateSnapshot(): void {
  invalidateResolvedSnapshot().catch(() => undefined);
}

/* ─── Op handlers ───────────────────────────────────────────────────── */

const enable: OpHandler = async (ctx, raw) => {
  const p = EnablePayload.parse(raw);
  const nodeName = p.nodeName ?? `ts-${p.hostname}`;
  const groupName = p.groupName ?? DEFAULT_GROUP_NAME;
  const stateDir = p.stateDir ?? `./ts-${p.hostname}`;

  // Validate the anchor before writing anything.
  const parsedBase = await loadParsedBase(ctx.profileId);
  const anchor = p.anchor ?? parsedBase.anchors[0];
  if (!anchor) {
    throw ProblemDetailsError.unprocessable(
      'base.yaml 的 rules 段没有锚点(# === ANCHOR: name ===),无法放置规则;请先加一个锚点。',
    );
  }
  if (!parsedBase.anchors.includes(anchor)) {
    throw ProblemDetailsError.unprocessable(`anchor "${anchor}" 在 base.yaml 中不存在`);
  }

  // ── Step 1: base-literal node (reconcile: adopt an existing one) ────
  const record: Record<string, unknown> = {
    name: nodeName,
    type: 'tailscale',
    hostname: p.hostname,
    ...(p.authKey !== undefined ? { 'auth-key': p.authKey } : {}),
    ...(p.controlUrl !== undefined ? { 'control-url': p.controlUrl } : {}),
    'state-dir': stateDir,
    udp: p.udp,
    'accept-routes': p.acceptRoutes,
    ...(p.exitNode !== undefined ? { 'exit-node': p.exitNode } : {}),
  };

  let nodeCreated = false;
  let nodeSnapshot: RedactedTailscaleNode | null = null;
  {
    const { doc } = await ctx.base.read();
    const existing = findProxyMap(doc, nodeName);
    if (existing) {
      if (existing.get('type') !== 'tailscale') {
        throw ProblemDetailsError.conflict(
          `base.yaml 已有同名非 tailscale 节点 "${nodeName}";换个节点名。`,
        );
      }
      nodeSnapshot = redactNode(existing.toJSON() as Record<string, unknown>);
    }
  }
  if (!nodeSnapshot) {
    await ctx.base.withDocument((doc) => {
      const raced = findProxyMap(doc, nodeName);
      if (raced) {
        if (raced.get('type') !== 'tailscale') {
          throw ProblemDetailsError.conflict(
            `base.yaml 已有同名非 tailscale 节点 "${nodeName}";换个节点名。`,
          );
        }
        return;
      }
      appendProxyMap(doc, record);
    });
    nodeCreated = true;
    nodeSnapshot = redactNode(record);
  }

  // ── Step 2: group + rules in one atomic commit (reconcile both) ────
  let groupCreated = false;
  const groupWrites: ProxyGroup[] = [];
  const existingGroup = await getProxyGroupByName(ctx.profileId, groupName);
  if (existingGroup) {
    if (!(existingGroup.proxies ?? []).includes(nodeName)) {
      throw ProblemDetailsError.conflict(
        `策略组 "${groupName}" 已存在且不包含节点 "${nodeName}";换个组名,或在策略组页面手动接入。`,
      );
    }
  } else {
    const parsed = ProxyGroupCreateSchema.parse({
      kind: 'raw',
      name: groupName,
      type: 'select',
      proxies: [nodeName],
      notes: GROUP_NOTES,
    });
    const now = nowSeconds();
    groupWrites.push({
      ...parsed,
      id: generateProxyGroupId(),
      rank: await nextGroupRank(ctx.profileId),
      created_at: now,
      updated_at: now,
    } as ProxyGroup);
    groupCreated = true;
  }

  const wantedCidrs = [...new Set([TAILNET_CIDR, ...p.extraCidrs])];
  const existingRules = await listRules(ctx.profileId);
  const covered = new Set(
    existingRules
      .filter((r) => r.policy === groupName && (r.type === 'IP-CIDR' || r.type === 'IP-CIDR6'))
      .map((r) => r.value),
  );
  const ruleWrites: Rule[] = [];
  {
    const now = nowSeconds();
    let rank = await ctx.rules.computeNextRank(anchor);
    for (const cidr of wantedCidrs) {
      if (covered.has(cidr)) continue;
      const input = RuleCreateSchema.parse({
        anchor,
        type: cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR',
        value: cidr,
        policy: groupName,
        options: ['no-resolve'],
        source: 'manual',
        note: RULE_NOTE,
      });
      ruleWrites.push({
        id: generateRuleId(),
        anchor: input.anchor,
        type: input.type,
        value: input.value,
        policy: input.policy,
        rank,
        source: input.source,
        added_at: now,
        updated_at: now,
        note: input.note,
        options: input.options,
        enabled: input.enabled,
      });
      rank += RANK_STEP;
    }
  }

  if (groupWrites.length > 0 || ruleWrites.length > 0) {
    // Fresh planning version on purpose — step 1 already bumped config:version
    // past ctx.configVersion. The commit itself is still CAS-guarded.
    await preflightAndCommitProfileChanges(ctx.profileId, {
      proxyGroupWrites: groupWrites,
      ruleWrites,
    });
    invalidateSnapshot();
  }

  const snap: EnableSnapshot = {
    nodeName,
    groupName,
    anchor,
    created: { node: nodeCreated, group: groupCreated, ruleIds: ruleWrites.map((r) => r.id) },
    node: nodeSnapshot,
    rules: ruleWrites,
  };
  const events: AuditEventInput[] =
    nodeCreated || groupCreated || ruleWrites.length > 0
      ? [{ action: 'enable', target: { kind: 'proxy', name: nodeName }, after: snap }]
      : [];
  return {
    data: {
      nodeName,
      groupName,
      anchor,
      nodeCreated,
      groupCreated,
      createdRules: ruleWrites.map((r) => ({ id: r.id, type: r.type, value: r.value })),
      alreadyEnabled: events.length === 0,
    },
    events,
  };
};

const updateAuthKey: OpHandler = async (ctx, raw) => {
  const { nodeName, authKey } = UpdateAuthKeyPayload.parse(raw);
  await ctx.base.withDocument((doc) => {
    const node = findProxyMap(doc, nodeName);
    if (!node) {
      throw ProblemDetailsError.notFound(`base.yaml 里没有节点 "${nodeName}"。`);
    }
    if (node.get('type') !== 'tailscale') {
      throw ProblemDetailsError.unprocessable(`节点 "${nodeName}" 不是 tailscale 类型。`);
    }
    node.set('auth-key', authKey);
  });
  // Snapshots stay credential-free, which is exactly why this op has no inverse.
  return {
    data: { nodeName, updated: true },
    events: [
      {
        action: 'update-auth-key',
        target: { kind: 'proxy', name: nodeName },
      },
    ],
  };
};

/** Resolve which node/group a bare `disable` refers to, tolerating leftovers. */
async function detectTarget(
  ctx: OpContext,
  wanted: { nodeName?: string; groupName?: string },
): Promise<{ nodeName: string; groupName: string }> {
  const { doc } = await ctx.base.read();
  const seq = getProxiesSeq(doc);
  const tsNames: string[] = [];
  for (const item of seq?.items ?? []) {
    if (isMap(item) && item.get('type') === 'tailscale') tsNames.push(String(item.get('name')));
  }
  let nodeName = wanted.nodeName;
  if (!nodeName) {
    if (tsNames.length === 0) {
      throw ProblemDetailsError.notFound('base.yaml 里没有 tailscale 节点。');
    }
    if (tsNames.length > 1) {
      throw ProblemDetailsError.unprocessable(
        `base.yaml 里有多个 tailscale 节点(${tsNames.join(', ')}),请显式指定 nodeName。`,
      );
    }
    nodeName = tsNames[0];
  }
  let groupName = wanted.groupName;
  if (!groupName) {
    const candidates = (await listProxyGroups(ctx.profileId)).filter((g) =>
      (g.proxies ?? []).includes(nodeName),
    );
    if (candidates.length > 1) {
      throw ProblemDetailsError.unprocessable(
        `多个策略组引用节点 "${nodeName}"(${candidates.map((g) => g.name).join(', ')}),请显式指定 groupName。`,
      );
    }
    groupName = candidates[0]?.name ?? DEFAULT_GROUP_NAME;
  }
  return { nodeName, groupName };
}

const disable: OpHandler = async (ctx, raw) => {
  const wanted = DisablePayload.parse(raw);
  const { nodeName, groupName } = await detectTarget(ctx, wanted);

  const allGroups = await listProxyGroups(ctx.profileId);
  const allRules = await listRules(ctx.profileId);
  const group = allGroups.find((g) => g.name === groupName) ?? null;
  if (group) assertManagedTailscaleGroup(group, nodeName);

  // Anything else pinning the artifacts down → refuse before touching data.
  const refs = scanForeignReferences(allGroups, allRules, nodeName, groupName);
  if (refs.length > 0) {
    throw ProblemDetailsError.conflict(
      `无法一键拆除,存在外部引用: ${refs.slice(0, 5).join('; ')}${refs.length > 5 ? ' 等' : ''}。请先在对应模块解除引用。`,
    );
  }

  // Every rule targeting the group dies with it — they'd block its deletion.
  const doomedRules = allRules.filter((r) => r.policy === groupName);

  // ── Step 1: rules + group in one atomic commit ─────────────────────
  if (doomedRules.length > 0 || group) {
    await preflightAndCommitProfileChanges(ctx.profileId, {
      ruleDeletes: doomedRules.map((r) => r.id),
      proxyGroupDeletes: group ? [group.id] : [],
    });
    invalidateSnapshot();
  }

  // ── Step 2: base-literal node ──────────────────────────────────────
  const { result: nodeSnapshot } = await ctx.base.withDocument<RedactedTailscaleNode | null>(
    (doc) => {
      const node = findProxyMap(doc, nodeName);
      if (!node) return null;
      if (node.get('type') !== 'tailscale') {
        throw ProblemDetailsError.conflict(`节点 "${nodeName}" 不是 tailscale 类型,拒绝移除。`);
      }
      const snap = redactNode(node.toJSON() as Record<string, unknown>);
      removeProxyMap(doc, nodeName);
      return snap;
    },
  );

  if (!nodeSnapshot && !group && doomedRules.length === 0) {
    throw ProblemDetailsError.notFound(`没有找到可拆除的 tailscale 产物("${nodeName}"/"${groupName}")。`);
  }

  const snap: DisableSnapshot = {
    nodeName,
    groupName,
    node: nodeSnapshot,
    group,
    rules: doomedRules,
  };
  return {
    data: {
      nodeName,
      groupName,
      removed: {
        node: nodeSnapshot !== null,
        group: group !== null,
        ruleIds: doomedRules.map((r) => r.id),
      },
      authKeyNote: nodeSnapshot?.hasAuthKey
        ? '节点已删除;auth-key 不进快照,撤销此操作后需重新填写。'
        : undefined,
    },
    events: [{ action: 'disable', target: { kind: 'proxy', name: nodeName }, before: snap }],
  };
};

/* ─── Inverses ──────────────────────────────────────────────────────── */

/** Undo `enable`: tear down ONLY what that event created, reverse order. */
const inverseEnable: InverseHandler = async (ctx, event) => {
  const after = event.after as EnableSnapshot | undefined;
  if (!after?.created) {
    throw ProblemDetailsError.unprocessable('Event missing enable snapshot.');
  }
  const { nodeName, groupName } = after;

  const ruleDeletes: string[] = [];
  const removedRules: Rule[] = [];
  for (const rule of after.rules) {
    const current = await ctx.rules.get(rule.id);
    if (!current) continue;
    if (current.updated_at !== rule.updated_at) {
      throw ProblemDetailsError.conflict(`规则 ${rule.id} 在此事件后被修改过,拒绝撤销。`);
    }
    ruleDeletes.push(rule.id);
    removedRules.push(current);
  }

  let group: ProxyGroup | null = null;
  if (after.created.group) {
    group = await getProxyGroupByName(ctx.profileId, groupName);
    if (group) {
      assertManagedTailscaleGroup(group, nodeName);
      const refs = scanForeignReferences(
        await listProxyGroups(ctx.profileId),
        (await listRules(ctx.profileId)).filter((r) => !ruleDeletes.includes(r.id)),
        nodeName,
        groupName,
      );
      // Rules targeting the node directly only block the teardown when the
      // node itself is about to be removed.
      const relevant = after.created.node ? refs : refs.filter((r) => !r.includes('指向节点'));
      if (relevant.length > 0) {
        throw ProblemDetailsError.conflict(`产物仍被引用,拒绝撤销: ${relevant.join('; ')}`);
      }
      const leftoverRules = (await listRules(ctx.profileId)).filter(
        (r) => r.policy === groupName && !ruleDeletes.includes(r.id),
      );
      if (leftoverRules.length > 0) {
        throw ProblemDetailsError.conflict(
          `仍有 ${leftoverRules.length} 条非本次创建的规则指向 "${groupName}",拒绝撤销。`,
        );
      }
    }
  }

  if (ruleDeletes.length > 0 || group) {
    await preflightAndCommitProfileChanges(ctx.profileId, {
      ruleDeletes,
      proxyGroupDeletes: group ? [group.id] : [],
    });
    invalidateSnapshot();
  }

  let nodeRemoved = false;
  if (after.created.node) {
    const { result } = await ctx.base.withDocument<boolean>((doc) => {
      const node = findProxyMap(doc, nodeName);
      if (!node) return false;
      if (node.get('type') !== 'tailscale') {
        throw ProblemDetailsError.conflict(`节点 "${nodeName}" 不是 tailscale 类型,拒绝移除。`);
      }
      return removeProxyMap(doc, nodeName);
    });
    nodeRemoved = result;
  }

  const snap: DisableSnapshot = {
    nodeName,
    groupName,
    node: nodeRemoved ? after.node : null,
    group,
    rules: removedRules,
  };
  return {
    data: { nodeName, groupName, removed: { node: nodeRemoved, group: group !== null, ruleIds: ruleDeletes } },
    events: [{ action: 'disable', target: { kind: 'proxy', name: nodeName }, before: snap }],
  };
};

/** Undo `disable`: recreate node (sans auth-key) → group + rules. */
const inverseDisable: InverseHandler = async (ctx, event) => {
  const before = event.before as DisableSnapshot | undefined;
  if (!before) {
    throw ProblemDetailsError.unprocessable('Event missing disable snapshot.');
  }
  const { nodeName, groupName } = before;

  let nodeCreated = false;
  if (before.node) {
    const snapNode = before.node;
    await ctx.base.withDocument((doc) => {
      const existing = findProxyMap(doc, nodeName);
      if (existing) {
        throw ProblemDetailsError.conflict(`base.yaml 里已有节点 "${nodeName}",拒绝重复恢复。`);
      }
      appendProxyMap(doc, nodeRecordFromSnapshot(snapNode));
    });
    nodeCreated = true;
  }

  const now = nowSeconds();
  const groupWrites: ProxyGroup[] = [];
  if (before.group) {
    const dup = await getProxyGroupByName(ctx.profileId, groupName);
    if (dup) {
      throw ProblemDetailsError.conflict(`策略组 "${groupName}" 已存在,拒绝重复恢复。`);
    }
    groupWrites.push({ ...before.group, updated_at: now });
  }

  const parsedBase = await loadParsedBase(ctx.profileId);
  const ruleWrites: Rule[] = [];
  for (const rule of before.rules) {
    const existing = await ctx.rules.get(rule.id);
    if (existing) {
      throw ProblemDetailsError.conflict(`规则 ${rule.id} 已存在,拒绝重复恢复。`);
    }
    ensureValidAnchorAndPolicy(rule, {
      ...parsedBase,
      // The group being restored in the same commit is a valid policy target.
      policies: before.group ? [...parsedBase.policies, groupName] : parsedBase.policies,
    });
    ruleWrites.push({ ...rule, updated_at: now });
  }

  if (groupWrites.length > 0 || ruleWrites.length > 0) {
    await preflightAndCommitProfileChanges(ctx.profileId, {
      proxyGroupWrites: groupWrites,
      ruleWrites,
    });
    invalidateSnapshot();
  }

  const snap: EnableSnapshot = {
    nodeName,
    groupName,
    anchor: before.rules[0]?.anchor ?? '',
    created: {
      node: nodeCreated,
      group: groupWrites.length > 0,
      ruleIds: ruleWrites.map((r) => r.id),
    },
    node: before.node ?? {
      name: nodeName,
      hasAuthKey: false,
    },
    rules: ruleWrites,
  };
  return {
    data: {
      nodeName,
      groupName,
      restored: snap.created,
      authKeyNote: before.node?.hasAuthKey
        ? '节点已恢复,但 auth-key 不进快照——请到 Tailscale 页面重新填写。'
        : undefined,
    },
    events: [{ action: 'enable', target: { kind: 'proxy', name: nodeName }, after: snap }],
  };
};

/* ─── Read side (page summary) ──────────────────────────────────────── */

export interface TailscaleSummary {
  initialized: boolean;
  nodes: RedactedTailscaleNode[];
  groups: Array<Pick<ProxyGroup, 'id' | 'name' | 'type' | 'proxies'> & { managedShape: boolean }>;
  rules: Array<Pick<Rule, 'id' | 'anchor' | 'type' | 'value' | 'policy' | 'enabled' | 'note'>>;
  anchors: string[];
}

export async function summariseTailscale(profileId: string): Promise<TailscaleSummary> {
  const base = await getBase(profileId);
  if (!base) return { initialized: false, nodes: [], groups: [], rules: [], anchors: [] };

  const parsed = await loadParsedBase(profileId);
  const doc = parseDocument(base.content);
  const nodes: RedactedTailscaleNode[] = [];
  const seq = doc.get('proxies', true);
  if (isSeq(seq)) {
    for (const item of seq.items) {
      if (isMap(item) && item.get('type') === 'tailscale') {
        nodes.push(redactNode(item.toJSON() as Record<string, unknown>));
      }
    }
  }
  const nodeNames = new Set(nodes.map((n) => n.name));

  const groups = (await listProxyGroups(profileId))
    .filter((g) => (g.proxies ?? []).some((m) => nodeNames.has(m)))
    .map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      proxies: g.proxies,
      managedShape:
        g.type === 'select' &&
        g['dialer-proxy'] === undefined &&
        (g.proxies ?? []).length === 1,
    }));
  const groupNames = new Set(groups.map((g) => g.name));

  const rules = (await listRules(profileId))
    .filter((r) => groupNames.has(r.policy) || nodeNames.has(r.policy))
    .map((r) => ({
      id: r.id,
      anchor: r.anchor,
      type: r.type,
      value: r.value,
      policy: r.policy,
      enabled: r.enabled,
      note: r.note,
    }));

  return { initialized: true, nodes, groups, rules, anchors: parsed.anchors };
}

/* ─── Export ────────────────────────────────────────────────────────── */

export const tailscaleScenario: Scenario = {
  descriptor: {
    id: 'tailscale',
    title: 'Tailscale',
    description:
      '一键接入 tailnet：写入 base 字面 tailscale 节点、一个 select 策略组与 CGNAT 规则 —— 之后都是普通模块管辖的普通产物。',
    navHref: '/scenarios/tailscale',
  },
  ops: {
    enable,
    'update-auth-key': updateAuthKey,
    disable,
  },
  inverses: {
    enable: inverseEnable,
    disable: inverseDisable,
    // update-auth-key deliberately has no inverse: snapshots are credential-free.
  },
};
