/**
 * Node-processing operator actions — a read + a dry-run preview plus gated
 * fine-grained add / update / delete / reorder writes over a 订阅源
 * (subscription) or 聚合订阅 (collection) 的「节点处理」算子管线
 * (Sub-Store calls these 节点操作).
 *
 * Operators filter / rename / dedup / sort / flag the parsed nodes of a
 * source, in array order; they never invent nodes. The pipeline is an ordered
 * array on the source record (`sub.operators` / `collection.operators`). These
 * actions mutate that array through the very services the 订阅源 page uses
 * (`patchSubscription` / `patchCollection` — each bumps config:version and
 * invalidates the resolved snapshot), fronted by the assistant's confirmation
 * handshake (`defineWriteAction`: preview → card → execute).
 *
 * Headline pairing: `preview_node_operators` (read — dry-run the whole
 * candidate pipeline against the source's real nodes to verify a regex BEFORE
 * editing) + `add_operator` / `update_operator` (write). Mirrors the
 * preview_proxy_group_members + update_proxy_group discipline.
 */

import { z } from 'zod';
import { stringify } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { findNodeReferences } from '@/lib/services/nodeReferenceService';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import {
  getCollection,
  listCollections,
  patchCollection,
} from '@/lib/services/collectionService';
import {
  getSubscription,
  listSubscriptions,
  patchSubscription,
} from '@/lib/services/subscriptionService';
import {
  DedupOpSchema,
  FilterRegexOpSchema,
  FilterRegionOpSchema,
  FilterTypeOpSchema,
  FilterUselessOpSchema,
  FlagEmojiOpSchema,
  OperatorSchema,
  RenameRegexOpSchema,
  SetPropOpSchema,
  SortOpSchema,
  type Operator,
} from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

/** How many node names to inline in a preview before truncating. */
const NAME_CAP = 300;

const SourceType = z
  .enum(['subscription', 'collection'])
  .describe('源类型：subscription 普通订阅源 / collection 聚合订阅');

/**
 * AI-facing operator spec — the real operator branches with `id` omitted, so
 * the model never has to invent stable ids. We materialise the id server-side
 * (new uuid on add, preserved on update). Kept in lock-step with
 * schemas/operator.ts; adding an operator kind means adding a branch here too.
 */
const AiOperatorSchema = z
  .discriminatedUnion('kind', [
    FilterRegexOpSchema.omit({ id: true }),
    FilterUselessOpSchema.omit({ id: true }),
    RenameRegexOpSchema.omit({ id: true }),
    FlagEmojiOpSchema.omit({ id: true }),
    FilterTypeOpSchema.omit({ id: true }),
    SortOpSchema.omit({ id: true }),
    SetPropOpSchema.omit({ id: true }),
    DedupOpSchema.omit({ id: true }),
    FilterRegionOpSchema.omit({ id: true }),
  ])
  .describe(
    '一个节点处理算子。kind 之一：filter-regex 正则过滤(mode keep/drop + pattern) / ' +
      'filter-useless 去无用节点(extra 额外关键词) / rename-regex 正则重命名(pattern + replacement，空 replacement=删除匹配) / ' +
      'flag-emoji 国旗(action add/remove，tw2cn 台湾用中国旗) / filter-type 类型过滤(mode + types) / ' +
      'sort 排序(by name/type/server/region + order) / set-prop 设属性(udp/tfo/skipCertVerify) / ' +
      'dedup 去重(by name/server-port + action drop/rename) / filter-region 地区过滤(mode + regions 如 HK/JP/US)。不用给 id。',
  );
type AiOperator = z.infer<typeof AiOperatorSchema>;

/** Promote an AI operator spec into a stored, fully-validated Operator. */
function materialize(spec: AiOperator, id: string): Operator {
  return OperatorSchema.parse({ ...spec, id });
}

/* ─── source abstraction (subscription | collection share the pipeline) ── */

interface SourceHandle {
  type: 'subscription' | 'collection';
  id: string;
  /** Human label for diffs / summaries. */
  label: string;
  operators: Operator[];
  save(next: Operator[]): Promise<void>;
}

async function loadSource(type: 'subscription' | 'collection', id: string): Promise<SourceHandle> {
  if (type === 'subscription') {
    const sub = await getSubscription(id);
    if (!sub) throw ProblemDetailsError.notFound(`订阅源 ${id} 不存在。`);
    return {
      type,
      id,
      label: sub.display_name || sub.name,
      operators: sub.operators ?? [],
      save: async (next) => {
        await patchSubscription(id, { operators: next });
      },
    };
  }
  const col = await getCollection(id);
  if (!col) throw ProblemDetailsError.notFound(`聚合订阅 ${id} 不存在。`);
  return {
    type,
    id,
    label: col.name,
    operators: col.operators ?? [],
    save: async (next) => {
      await patchCollection(id, { operators: next });
    },
  };
}

/** Fetch the source's *raw* (pre-operator) node list for a dry-run. */
async function sourceRawProxies(
  handle: SourceHandle,
  noCache: boolean,
): Promise<{ proxies: ClashProxy[]; memberErrors?: unknown[] }> {
  if (handle.type === 'subscription') {
    const sub = await getSubscription(handle.id);
    if (!sub) throw ProblemDetailsError.notFound(`订阅源 ${handle.id} 不存在。`);
    const { proxies } = await resolveSubscriptionProxiesRaw(sub, { noCache });
    return { proxies: proxies as ClashProxy[] };
  }
  const col = await getCollection(handle.id);
  if (!col) throw ProblemDetailsError.notFound(`聚合订阅 ${handle.id} 不存在。`);
  const subs = await listSubscriptions();
  const { merged, memberErrors } = await mergeCollectionMemberProxies(col, subs, { noCache });
  return { proxies: merged as ClashProxy[], memberErrors };
}

function namesPayload(proxies: ClashProxy[]): { count: number; names: string[]; truncated: boolean } {
  const names = proxies
    .slice(0, NAME_CAP)
    .map((p) => (typeof p.name === 'string' ? p.name : '(无名)'));
  return { count: proxies.length, names, truncated: proxies.length > NAME_CAP };
}

/* ─── diff / result helpers ─────────────────────────────────────────── */

function opsYaml(ops: Operator[]): string {
  if (ops.length === 0) return '(空管线)';
  return stringify(ops).trimEnd();
}

function opsDiff(handle: SourceHandle, before: Operator[], after: Operator[]): unknown {
  const bucket = handle.type === 'subscription' ? 'subscriptions' : 'collections';
  return {
    op: 'update',
    path: `${bucket}[${handle.label}].operators`,
    beforeYaml: opsYaml(before),
    afterYaml: opsYaml(after),
  };
}

function writeResult(op: string, summary: string, data: unknown): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events: [] } };
}

function insertAt(arr: Operator[], op: Operator, pos?: number): Operator[] {
  const next = [...arr];
  if (pos === undefined || pos >= next.length) next.push(op);
  else next.splice(Math.max(0, pos), 0, op);
  return next;
}

function sourceLabel(t: 'subscription' | 'collection'): string {
  return t === 'subscription' ? '订阅源' : '聚合订阅';
}

/* ─── list_node_sources ─────────────────────────────────────────────── */

const listNodeSources = defineAction({
  name: 'list_node_sources',
  description:
    '列出全部订阅源(subscription)与聚合订阅(collection)及其「节点处理」算子管线。每个源含 type/id(增删改算子时用)/name/slug/enabled，以及 operators 数组(每个算子含 id、kind 及其参数)。要管理算子(过滤/重命名/去重/排序/加国旗等)、或在 add/update/delete/reorder_operator 前拿 source id 与算子 id 时调用。只读，不含节点密码 / 订阅 URL。',
  input: z.object({}),
  risk: 'read',
  async run() {
    const [subs, cols] = await Promise.all([listSubscriptions(), listCollections()]);
    return {
      kind: 'node-sources',
      data: {
        subscriptions: subs.map((s) => ({
          id: s.id,
          name: s.display_name || s.name,
          slug: s.name,
          enabled: s.enabled,
          kind: s.kind,
          operatorCount: s.operators.length,
          operators: s.operators,
        })),
        collections: cols.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug ?? null,
          enabled: c.enabled,
          operatorCount: c.operators.length,
          operators: c.operators,
        })),
      },
    };
  },
});

/* ─── preview_node_operators ────────────────────────────────────────── */

const PreviewInput = z.object({
  source_type: SourceType,
  id: z.uuid().describe('订阅源 / 聚合订阅 的 id(先用 list_node_sources 拿)'),
  operators: z
    .array(AiOperatorSchema)
    .describe('要试算的完整算子管线(按顺序整条给)；空数组=只看原始节点'),
  no_cache: z
    .boolean()
    .optional()
    .describe('true 则跳过抓取缓存强制刷新上游(慢，默认 false 用缓存)'),
});

const previewOperators = defineAction({
  name: 'preview_node_operators',
  description:
    '试算一条算子管线作用到某订阅源 / 聚合订阅的真实节点上会得到什么——拿该源节点(订阅源=上游抓取并标准化后、聚合订阅=合并成员节点后)，按顺序跑你给的整条 operators 管线，返回处理前 / 后的节点名与每步 before/after/dropped/changed 跟踪。改算子(尤其正则过滤 / 重命名)前务必先调用验证命中正确(常见坑：裸 us 会顺带吃进 A-us-tralia / R-us-sia，应用单词边界或地区算子)。只读、不保存。',
  input: PreviewInput,
  risk: 'read',
  async run(ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const ops = input.operators.map((spec, i) => materialize(spec, `preview-${i}`));
    const { proxies: before, memberErrors } = await sourceRawProxies(handle, input.no_cache === true);
    const { proxies: after, steps } = applyOperators(before, ops);

    // Names present before but gone after = renamed-or-dropped. If any was
    // pinned by a chain backend / proxy-group member / rule, the pipeline would
    // orphan that reference (and a chain backend orphan crashes mihomo on load).
    const beforeNames = before.map((p) => (typeof p.name === 'string' ? p.name : ''));
    const afterNames = new Set(after.map((p) => (typeof p.name === 'string' ? p.name : '')));
    const disappeared = [...new Set(beforeNames)].filter((n) => n && !afterNames.has(n));
    const orphanedReferences = await findNodeReferences(ctx.profileId, disappeared);

    return {
      kind: 'node-operators-preview',
      data: {
        source: handle.label,
        sourceType: handle.type,
        before: namesPayload(before),
        after: namesPayload(after),
        steps,
        ...(memberErrors && memberErrors.length ? { memberErrors } : {}),
        orphanedReferences,
        ...(orphanedReferences.length
          ? {
              orphanWarning:
                '⚠️ 这些节点改名/被过滤后，会让链式代理后端、策略组成员或规则的引用悬空(尤其 chain-backend 会导致整份配置无法加载)。落地前请提醒用户，并提议一并更新这些引用。',
            }
          : {}),
      },
    };
  },
});

/* ─── add_operator ──────────────────────────────────────────────────── */

const AddInput = z.object({
  source_type: SourceType,
  id: z.uuid().describe('订阅源 / 聚合订阅 的 id(先用 list_node_sources 拿)'),
  operator: AiOperatorSchema,
  position: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('插入位置下标(0=管线最前)；省略=追加到末尾。算子按管线顺序依次作用，顺序影响结果'),
});

const addOperator = defineWriteAction({
  name: 'add_operator',
  description:
    '给一个订阅源 / 聚合订阅的算子管线新增一个节点处理步骤(过滤 / 重命名 / 去无用 / 去重 / 排序 / 加国旗 / 类型或地区过滤 / 设属性)。需用户确认。算子按管线顺序依次作用，可用 position 指定插入位置。新增正则类算子前先用 preview_node_operators 验证命中。先用 list_node_sources 拿 id。',
  input: AddInput,
  risk: 'write',
  summary: (i) => `给${sourceLabel(i.source_type)}新增算子 ${i.operator.kind}`,
  async preview(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const next = insertAt(handle.operators, materialize(input.operator, 'new'), input.position);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const op = materialize(input.operator, crypto.randomUUID());
    const next = insertAt(handle.operators, op, input.position);
    await handle.save(next);
    return writeResult('update', `已给 ${handle.label} 新增算子 ${op.kind}`, {
      id: handle.id,
      operatorId: op.id,
      count: next.length,
    });
  },
});

/* ─── update_operator ───────────────────────────────────────────────── */

const UpdateInput = z.object({
  source_type: SourceType,
  id: z.uuid().describe('订阅源 / 聚合订阅 的 id'),
  operator_id: z.string().min(1).describe('要修改的算子 id(用 list_node_sources 拿)'),
  operator: AiOperatorSchema.describe(
    '该算子的新完整定义(不用给 id，沿用原 id)。整条替换：可借此换 kind 或改任意参数',
  ),
});

const updateOperator = defineWriteAction({
  name: 'update_operator',
  description:
    '修改算子管线里某一个步骤(按 operator_id 定位，整条替换为你给的新定义，位置与 id 不变)。需用户确认。改正则前先用 preview_node_operators 验证。先用 list_node_sources 拿 source id 与算子 id。',
  input: UpdateInput,
  risk: 'write',
  summary: (i) => `修改${sourceLabel(i.source_type)}的算子 → ${i.operator.kind}`,
  async preview(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const idx = handle.operators.findIndex((o) => o.id === input.operator_id);
    if (idx === -1) throw ProblemDetailsError.notFound(`算子 ${input.operator_id} 不在该源管线里。`);
    const next = [...handle.operators];
    next[idx] = materialize(input.operator, input.operator_id);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const idx = handle.operators.findIndex((o) => o.id === input.operator_id);
    if (idx === -1) throw ProblemDetailsError.notFound(`算子 ${input.operator_id} 不在该源管线里。`);
    const next = [...handle.operators];
    next[idx] = materialize(input.operator, input.operator_id);
    await handle.save(next);
    return writeResult('update', `已修改 ${handle.label} 的算子 ${next[idx].kind}`, {
      id: handle.id,
      operatorId: input.operator_id,
    });
  },
});

/* ─── delete_operator ───────────────────────────────────────────────── */

const DeleteInput = z.object({
  source_type: SourceType,
  id: z.uuid().describe('订阅源 / 聚合订阅 的 id'),
  operator_id: z.string().min(1).describe('要删除的算子 id(用 list_node_sources 拿)'),
});

const deleteOperator = defineWriteAction({
  name: 'delete_operator',
  description:
    '从算子管线里删除一个步骤(按 operator_id)。需用户确认。先用 list_node_sources 拿 source id 与算子 id。',
  input: DeleteInput,
  risk: 'write',
  summary: (i) => `删除${sourceLabel(i.source_type)}的一个算子`,
  async preview(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const next = handle.operators.filter((o) => o.id !== input.operator_id);
    if (next.length === handle.operators.length)
      throw ProblemDetailsError.notFound(`算子 ${input.operator_id} 不在该源管线里。`);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const removed = handle.operators.find((o) => o.id === input.operator_id);
    if (!removed) throw ProblemDetailsError.notFound(`算子 ${input.operator_id} 不在该源管线里。`);
    const next = handle.operators.filter((o) => o.id !== input.operator_id);
    await handle.save(next);
    return writeResult('update', `已从 ${handle.label} 删除算子 ${removed.kind}`, {
      id: handle.id,
      operatorId: input.operator_id,
      count: next.length,
    });
  },
});

/* ─── reorder_operators ─────────────────────────────────────────────── */

const ReorderInput = z.object({
  source_type: SourceType,
  id: z.uuid().describe('订阅源 / 聚合订阅 的 id'),
  operator_ids: z
    .array(z.string().min(1))
    .min(1)
    .describe('管线里全部算子 id 的新顺序——必须是现有算子 id 的一个全排列(不多不少)'),
});

/** Reorder by a full permutation of existing ids; reject partial/unknown sets. */
function reordered(current: Operator[], orderedIds: string[]): Operator[] {
  const byId = new Map(current.map((o) => [o.id, o]));
  if (orderedIds.length !== current.length || new Set(orderedIds).size !== orderedIds.length) {
    throw ProblemDetailsError.badRequest('operator_ids 必须是现有算子 id 的一个全排列(不重复、不多不少)。');
  }
  const next: Operator[] = [];
  for (const oid of orderedIds) {
    const op = byId.get(oid);
    if (!op) throw ProblemDetailsError.badRequest(`算子 ${oid} 不在该源管线里。`);
    next.push(op);
  }
  return next;
}

const reorderOperators = defineWriteAction({
  name: 'reorder_operators',
  description:
    '重排算子管线的执行顺序(算子按顺序依次作用，顺序会影响结果，比如「先重命名再过滤」与「先过滤再重命名」不同)。需用户确认。operator_ids 要给该源全部算子 id 的新排列。先用 list_node_sources 拿 id。',
  input: ReorderInput,
  risk: 'write',
  summary: (i) => `重排${sourceLabel(i.source_type)}的算子顺序`,
  async preview(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const next = reordered(handle.operators, input.operator_ids);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(_ctx, input) {
    const handle = await loadSource(input.source_type, input.id);
    const next = reordered(handle.operators, input.operator_ids);
    await handle.save(next);
    return writeResult('update', `已重排 ${handle.label} 的算子顺序`, {
      id: handle.id,
      order: input.operator_ids,
    });
  },
});

export const OPERATOR_READ_ACTIONS = [listNodeSources, previewOperators];
export const OPERATOR_WRITE_ACTIONS = [
  addOperator,
  updateOperator,
  deleteOperator,
  reorderOperators,
];
