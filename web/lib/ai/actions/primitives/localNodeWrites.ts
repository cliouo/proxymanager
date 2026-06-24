/**
 * Local-node actions — list + rename the nodes of a `kind: 'local'`
 * subscription directly at the source (its inline `content`), which the user
 * owns. Remote sources can't be edited this way (nodes come from upstream) —
 * for those, renaming goes through a rename-regex operator (see add_operator).
 *
 * Redaction: a local sub's content embeds node credentials (password / uuid /
 * psk …). These tools NEVER surface them to the model — `list_local_nodes`
 * returns only name + type, and `rename_local_node` only touches the `name`
 * field and shows a name-only diff. The full content (with secrets) is parsed,
 * mutated, and re-serialised entirely server-side. Editing normalises the
 * stored content to a Clash `proxies:` YAML block (fields preserved).
 */

import { z } from 'zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import { findNodeReferences } from '@/lib/services/nodeReferenceService';
import {
  parseLocalProxies,
  serialiseLocalProxies,
} from '@/lib/services/subscriptionFetcher';
import { getSubscription, patchSubscription } from '@/lib/services/subscriptionService';
import type { Subscription } from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

function writeResult(op: string, summary: string, data: unknown): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events: [] } };
}

/** Load a subscription and assert it's a local source with content. */
async function mustLocalSub(id: string): Promise<Subscription> {
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.notFound(`订阅源 ${id} 不存在。`);
  if (sub.kind !== 'local') {
    throw ProblemDetailsError.unprocessable(
      `订阅源「${sub.display_name || sub.name}」是远程源，原始节点来自上游、不能直接改名；` +
        `要改名请用 rename-regex 算子(add_operator)，它对远程源同样生效。`,
    );
  }
  if (!sub.content) {
    throw ProblemDetailsError.unprocessable(`本地订阅源「${sub.name}」没有节点内容。`);
  }
  return sub;
}

function nodeName(p: Record<string, unknown>): string {
  return typeof p.name === 'string' ? p.name : '(无名)';
}

/** Locate the single node matching `name`; surface 404 / ambiguity as errors. */
function locateUnique(proxies: Record<string, unknown>[], name: string): number {
  const idxs = proxies.flatMap((p, i) => (nodeName(p) === name ? [i] : []));
  if (idxs.length === 0) throw ProblemDetailsError.notFound(`本地源里没有名为「${name}」的节点。`);
  if (idxs.length > 1) {
    throw ProblemDetailsError.conflict(
      `本地源里有 ${idxs.length} 个节点都叫「${name}」，无法定位；请先消歧。`,
    );
  }
  return idxs[0];
}

/* ─── list_local_nodes ──────────────────────────────────────────────── */

const listLocalNodes = defineAction({
  name: 'list_local_nodes',
  description:
    '列出一个本地订阅源(kind=local，节点内容是用户自填的)的原始节点——只返回每个节点的 name 与 type，**不含密码 / uuid / 服务器等任何凭证**(已脱敏)。每个节点还带 referencedBy(它被哪些链式代理后端 / 策略组成员 / 规则按名引用)——**改名前若某节点 referencedBy 非空，务必提醒用户改名会断这些引用(尤其 chain-backend 会让整份配置加载失败)、并提议一并更新**。要用 rename_local_node 改名前先调用它拿准确名字。远程源没有可直接编辑的原始内容，对远程源调用会报错并提示改用 rename-regex 算子。先用 list_node_sources 拿订阅源 id 并确认其 kind。',
  input: z.object({
    id: z.uuid().describe('本地订阅源的 id(先用 list_node_sources 拿，kind 须为 local)'),
  }),
  risk: 'read',
  async run(ctx, input) {
    const sub = await mustLocalSub(input.id);
    const proxies = parseLocalProxies(sub.content!);
    const names = proxies.map((p) => nodeName(p));
    const refs = await findNodeReferences(ctx.profileId, names);
    const byNode = new Map<string, Array<{ kind: string; via: string }>>();
    for (const r of refs) {
      const list = byNode.get(r.node) ?? [];
      list.push({ kind: r.kind, via: r.via });
      byNode.set(r.node, list);
    }
    return {
      kind: 'local-nodes',
      data: {
        source: sub.display_name || sub.name,
        count: proxies.length,
        nodes: proxies.map((p) => {
          const name = nodeName(p);
          return { name, type: p.type ?? null, referencedBy: byNode.get(name) ?? [] };
        }),
      },
    };
  },
});

/* ─── rename_local_node ─────────────────────────────────────────────── */

const RenameInput = z.object({
  id: z.uuid().describe('本地订阅源的 id(kind 须为 local)'),
  from: z.string().min(1).describe('要改的节点当前完整名字(用 list_local_nodes 拿，须精确匹配且唯一)'),
  to: z.string().min(1).max(128).describe('新名字'),
});

const renameLocalNode = defineWriteAction({
  name: 'rename_local_node',
  description:
    '直接修改一个本地订阅源(kind=local)中某个节点的名字——改的是源内容本身(永久生效、非算子叠加层)，仅改 name 字段，其它配置与凭证原样保留。需用户确认。只适用于本地源；远程源请用 rename-regex 算子(add_operator)。要批量 / 按正则改本地源也可以用 rename-regex 算子(对本地源同样生效)。改之前用 list_local_nodes 拿准确的现有名字。',
  input: RenameInput,
  risk: 'write',
  summary: (i) => `本地节点改名：${i.from} → ${i.to}`,
  async preview(_ctx, input) {
    const sub = await mustLocalSub(input.id);
    const proxies = parseLocalProxies(sub.content!);
    locateUnique(proxies, input.from); // 404 / 冲突前置校验
    if (input.to !== input.from && proxies.some((p) => nodeName(p) === input.to)) {
      throw ProblemDetailsError.conflict(`本地源里已存在名为「${input.to}」的节点。`);
    }
    // Name-only diff — never echoes credentials from the content.
    return {
      diff: {
        op: 'update',
        path: `subscriptions[${sub.display_name || sub.name}].proxies`,
        beforeYaml: `name: ${input.from}`,
        afterYaml: `name: ${input.to}`,
      },
    };
  },
  async execute(_ctx, input) {
    const sub = await mustLocalSub(input.id);
    const proxies = parseLocalProxies(sub.content!);
    const idx = locateUnique(proxies, input.from);
    if (input.to !== input.from && proxies.some((p) => nodeName(p) === input.to)) {
      throw ProblemDetailsError.conflict(`本地源里已存在名为「${input.to}」的节点。`);
    }
    proxies[idx] = { ...proxies[idx], name: input.to };
    await patchSubscription(input.id, { content: serialiseLocalProxies(proxies) });
    return writeResult('update', `已将本地节点「${input.from}」改名为「${input.to}」`, {
      id: input.id,
      from: input.from,
      to: input.to,
    });
  },
});

export const LOCAL_NODE_READ_ACTIONS = [listLocalNodes];
export const LOCAL_NODE_WRITE_ACTIONS = [renameLocalNode];
