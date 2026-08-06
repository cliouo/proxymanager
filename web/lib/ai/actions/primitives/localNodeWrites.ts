/**
 * Local-node actions — list + rename the nodes of a `kind: 'local'`
 * subscription directly at the source (its inline `content`), which the user
 * owns. Remote sources can't be edited this way (nodes come from upstream) —
 * for those, renaming goes through a rename-regex operator (see add_operator).
 *
 * pass-8 blocker 4: the model surface is fully OPAQUE and profile-bound —
 * nodes are identified by keyed `nd-` handles minted under
 * (profileId, sourceId, position, name); raw node names, the raw source
 * label, server info, raw unknown protocol types and unbounded diagnostic
 * text never serialize. The name shown is a bounded redacted display used
 * only to tell nodes apart; selection/rename round-trips through the handle.
 * The full content (with secrets) is parsed, mutated, and re-serialised
 * entirely server-side. Editing normalises the stored content to a Clash
 * `proxies:` YAML block (fields preserved).
 */

import { z } from '@/lib/openapi/zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import { findNodeReferences } from '@/lib/services/nodeReferenceService';
import { parseLocalProxies, serialiseLocalProxies } from '@/lib/services/subscriptionFetcher';
import { getSubscription, patchSubscription } from '@/lib/services/subscriptionService';
import {
  callerVisibleNamingTargets,
  NAMING_REF_RE,
  requireCallerProfile,
  resolveRefInVisibleSet,
} from '@/lib/services/namingTargetScope';
import { buildNodeScope } from '@/lib/proxies/handleScopes';
import { sanitizeDisplayText } from '@/lib/ai/namingContextProjection';
import { canonicalProxyType, redactSensitiveText } from '@/lib/proxies/namingSanitize';
import type { ActionContext } from '../types';
import type { Subscription } from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

/** Profile-bound opaque ref — raw source UUIDs never enter the loop. */
const SourceRefInput = z.object({
  source_type: z.literal('subscription'),
  ref: z
    .string()
    .regex(NAMING_REF_RE, '目标引用格式不正确(先用 list_node_sources 拿 ref)')
    .describe('不透明目标引用(先用 list_node_sources 拿)'),
});

/** Opaque per-node handle shape: `nd-` + 16 hex. */
const NODE_HANDLE_RE = /^nd-[0-9a-f]{16}$/;

const STALE_NODE_HANDLE_ERROR = '节点句柄不存在或已失效，请重新获取节点列表。';

function writeResult(op: string, summary: string, data: unknown): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events: [] } };
}

/** Profile-bound ref resolution (pass-7): raw source UUIDs never cross the
 * model boundary — the caller-visible set authorizes every read/write.
 * The local-source existence check is the bounded non-oracle error. */
async function mustLocalSub(ctx: ActionContext, ref: string): Promise<Subscription> {
  const profile = await requireCallerProfile(ctx.profileId);
  const visible = await callerVisibleNamingTargets(profile);
  const { type, id } = resolveRefInVisibleSet(profile.id, 'subscription', ref, visible);
  if (type !== 'subscription') {
    throw ProblemDetailsError.badRequest('目标不存在或不在当前配置文件的来源范围内。');
  }
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.badRequest('目标不存在或不在当前配置文件的来源范围内。');
  if (sub.kind !== 'local') {
    throw ProblemDetailsError.unprocessable(
      '该订阅源是远程源，原始节点来自上游、不能直接改名；' +
        '要改名请用 rename-regex 算子(add_operator)，它对远程源同样生效。',
    );
  }
  if (!sub.content) {
    throw ProblemDetailsError.unprocessable('该本地订阅源没有节点内容。');
  }
  return sub;
}

function nodeName(p: Record<string, unknown>): string {
  return typeof p.name === 'string' ? p.name : '(无名)';
}

/**
 * round-1 (invariant 6): the list shows a BOUNDED SANITIZED display name —
 * the original node name after structural credential redaction (useful
 * recognition content; credentials never reach the loop). The AI identifies
 * nodes by the profile-bound opaque node handle; the display is only for
 * telling nodes apart.
 */
function nodeDisplayName(name: string): string {
  return sanitizeDisplayText(name) ?? '(未命名)';
}

/** Bounded redacted echo for MODEL-SUPPLIED text (the `to` name) — the
 * model's own input, capped + credential-redacted; never used for stored
 * node/source names. */
function safeInputLabel(text: string): string {
  const redacted = redactSensitiveText(text);
  return redacted.length > 48 ? `${redacted.slice(0, 48)}…` : redacted;
}

/**
 * pass-8 blocker 4: keyed PROFILE- and SOURCE-bound per-node handle. The
 * position makes handles unique even for identical names; the MAC makes them
 * opaque; replaying a handle against another profile/source fails the MAC.
 * Round-1: the typed node HandleScope owns the construction; every list
 * builds ONE collision-checked index over the COMPLETE parsed local source
 * before projection, and every resolution goes through that index.
 */
function buildLocalNodeScope(
  profileId: string,
  sourceId: string,
  proxies: Array<Record<string, unknown>>,
): ReturnType<typeof buildNodeScope> {
  return buildNodeScope(
    `${profileId}\x00${sourceId}`,
    proxies.map((p, i) => `${i}\x00${nodeName(p)}`),
  );
}

/**
 * Resolve a node handle against the parsed list through the complete-domain
 * scope — zero matches → stale bounded error, MAC collision → bounded
 * collision error at scope build time. Never a first-match pick.
 */
function resolveNodeHandle(
  profileId: string,
  sourceId: string,
  proxies: Array<Record<string, unknown>>,
  handle: string,
): number {
  const scope = buildLocalNodeScope(profileId, sourceId, proxies);
  const matched = scope.resolve(handle);
  if (matched === null) {
    throw ProblemDetailsError.badRequest(STALE_NODE_HANDLE_ERROR);
  }
  const position = Number(matched.split('\x00')[0]);
  return position;
}

/* ─── list_local_nodes ──────────────────────────────────────────────── */

const listLocalNodes = defineAction({
  name: 'list_local_nodes',
  description:
    '列出一个本地订阅源(kind=local，节点内容是用户自填的)的原始节点——只返回每个节点的**不透明节点句柄(nd-开头)**、有界脱敏显示名与协议类型(未知类型统一为 unknown)，**不含密码 / uuid / 服务器等任何凭证，不含原始节点名 / 原始来源名 / 服务器信息**(已脱敏)。每个节点还带 referencedBy(它被哪些链式代理后端 / 策略组成员 / 规则按名引用，名称有界脱敏)——**改名前若某节点 referencedBy 非空，务必提醒用户改名会断这些引用(尤其 chain-backend 会让整份配置加载失败)、并提议一并更新**。要用 rename_local_node 改名前先调用它拿节点句柄。远程源没有可直接编辑的原始内容，对远程源调用会报错并提示改用 rename-regex 算子。先用 list_node_sources 拿订阅源 ref 并确认其 kind。',
  input: SourceRefInput,
  risk: 'read',
  async run(ctx, input) {
    const profile = await requireCallerProfile(ctx.profileId);
    const sub = await mustLocalSub(ctx, input.ref);
    const proxies = parseLocalProxies(sub.content!);
    const names = proxies.map((p) => nodeName(p));
    // ONE collision-checked index over the COMPLETE parsed local source
    // BEFORE any projection (round-1 typed HandleScopes) — a MAC collision
    // anywhere in the list fails the response closed.
    const scope = buildLocalNodeScope(profile.id, sub.id, proxies);
    const refs = await findNodeReferences(ctx.profileId, names);
    const byNode = new Map<string, Array<{ kind: string; via: string }>>();
    for (const r of refs) {
      const list = byNode.get(r.node) ?? [];
      list.push({ kind: r.kind, via: r.via });
      byNode.set(r.node, list);
    }
    const nodes = proxies.map((p, i) => {
      const name = nodeName(p);
      return {
        // the ONLY identity the model may reuse — profile+source bound,
        // projected through the ONE collision-checked index over the
        // COMPLETE parsed local source (round-1 typed HandleScopes)
        node: scope.project(`${i}\x00${name}`),
        // pass-9 blocker 4: NON-REVERSIBLE ordinal label — the raw name
        // (even one character) never appears here
        display: nodeDisplayName(name),
        type: canonicalProxyType(p.type) ?? 'unknown',
        referencedBy: (byNode.get(name) ?? []).map((r, ri) => ({
          kind: r.kind,
          // referencing-entity names (chain backends embed node names)
          // project as bounded category ordinals — never the raw name
          via: `引用 ${ri + 1}`,
        })),
      };
    });
    return {
      kind: 'local-nodes',
      data: {
        ref: input.ref,
        count: proxies.length,
        nodes,
      },
    };
  },
});

/* ─── rename_local_node ─────────────────────────────────────────────── */

const RenameInput = SourceRefInput.extend({
  node: z
    .string()
    .regex(NODE_HANDLE_RE, '节点引用格式不正确(先用 list_local_nodes 拿)')
    .describe('要改的节点不透明句柄(用 list_local_nodes 拿，绝不传原始节点名)'),
  to: z.string().min(1).max(128).describe('新名字'),
});

const renameLocalNode = defineWriteAction({
  name: 'rename_local_node',
  description:
    '直接修改一个本地订阅源(kind=local)中某个节点的名字——改的是源内容本身(永久生效、非算子叠加层)，仅改 name 字段，其它配置与凭证原样保留。需用户确认。节点用 list_local_nodes 返回的不透明句柄(node)指定；新名字由你给(to)。只适用于本地源；远程源请用 rename-regex 算子(add_operator)。改之前用 list_local_nodes 拿节点句柄。',
  input: RenameInput,
  risk: 'write',
  summary: (i) => `本地节点改名：${safeInputLabel(i.to)}`,
  async preview(ctx, input) {
    const profile = await requireCallerProfile(ctx.profileId);
    const sub = await mustLocalSub(ctx, input.ref);
    const proxies = parseLocalProxies(sub.content!);
    const idx = resolveNodeHandle(profile.id, sub.id, proxies, input.node);
    if (proxies.some((p, i) => i !== idx && nodeName(p) === input.to)) {
      throw ProblemDetailsError.conflict(
        `本地源里已存在名为「${safeInputLabel(input.to)}」的节点。`,
      );
    }
    // Name-only diff — round-1: the OLD name projects as a bounded
    // SANITIZED display name (useful, credential-free); the NEW name is the
    // model's own bounded input. Never echoes credentials.
    return {
      diff: {
        op: 'update',
        path: 'subscriptions[该本地订阅源].proxies',
        beforeYaml: `name: ${nodeDisplayName(nodeName(proxies[idx]))}`,
        afterYaml: `name: ${safeInputLabel(input.to)}`,
      },
    };
  },
  async execute(ctx, input) {
    const profile = await requireCallerProfile(ctx.profileId);
    const sub = await mustLocalSub(ctx, input.ref);
    const proxies = parseLocalProxies(sub.content!);
    const idx = resolveNodeHandle(profile.id, sub.id, proxies, input.node);
    if (proxies.some((p, i) => i !== idx && nodeName(p) === input.to)) {
      throw ProblemDetailsError.conflict(
        `本地源里已存在名为「${safeInputLabel(input.to)}」的节点。`,
      );
    }
    proxies[idx] = { ...proxies[idx], name: input.to };
    await patchSubscription(sub.id, { content: serialiseLocalProxies(proxies) });
    return writeResult('update', `已将本地节点改名为「${safeInputLabel(input.to)}」`, {
      ref: input.ref,
      node: input.node,
      to: safeInputLabel(input.to),
    });
  },
});

export const LOCAL_NODE_READ_ACTIONS = [listLocalNodes];
export const LOCAL_NODE_WRITE_ACTIONS = [renameLocalNode];
