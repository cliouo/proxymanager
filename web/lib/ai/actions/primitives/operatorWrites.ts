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

import {
  NAMING_REF_RE,
  callerVisibleNamingTargets,
  NAMING_SCOPE_ERROR,
  requireCallerProfile,
  resolveRefInVisibleSet,
} from '@/lib/services/namingTargetScope';
import type { ActionContext } from '../types';
import { z } from '@/lib/openapi/zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { redactSensitiveText } from '@/lib/proxies/namingSanitize';
import { mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import {
  createOrdinalPlanningSession,
  resolveOrdinalsFor,
  type OrdinalPlanningSession,
} from '@/lib/services/nodeOrdinalService';
import { sourceOf } from '@/lib/proxies/provenance';
import { withRawIdentity } from '@/lib/proxies/naming';
import { findNodeReferences } from '@/lib/services/nodeReferenceService';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import { getCollection, listCollections, patchCollection } from '@/lib/services/collectionService';
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
  isActiveCurrentRenameTemplateOperator,
  isExecutableOperator,
  isParkedOperator,
  OperatorListSchema,
  OperatorSchema,
  RenameRegexOpSchema,
  RenameTemplateOpFieldsSchema,
  SetPropOpSchema,
  SortOpSchema,
  type Operator,
  type StoredOperator,
} from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';
import { ExternalSourceAliasesSchema } from '@/schemas/externalAliases';
import {
  assertGenericNamingRowsInvariant,
  buildOperatorSnapshot,
  type OperatorSnapshot,
} from '@/lib/services/operatorMutationPolicy';
import {
  buildOperatorScope,
  buildSourceAliasScope,
  buildTargetRefScope,
  type TypedHandleScope,
} from '@/lib/proxies/handleScopes';
import { resolveSourceAliasKeys } from '@/lib/services/sourceAliasResolver';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';

/** How many node names to inline in an AI preview before truncating —
 * round-1 (invariant 7): generic operator before/after MODEL projections
 * stay at no more than 80 each; the authenticated workbench preview keeps
 * its own larger cap (lib/services/pipelinePreview). */
const NAME_CAP = 80;

const SourceType = z
  .enum(['subscription', 'collection'])
  .describe('源类型：subscription 普通订阅源 / collection 聚合订阅');

// `safeExtend` preserves each stored branch's refinements. A defaulted
// literal keeps the output type assignable to the required stored `id` while
// letting AI callers omit it; materialize() always overwrites the sentinel
// with a server-generated/preserved id.
const GENERATED_OPERATOR_ID = z
  .literal('__generated_by_server__')
  .default('__generated_by_server__');

function withGeneratedOperatorId(schema: z.ZodObject): z.ZodObject {
  return schema.safeExtend({ id: GENERATED_OPERATOR_ID });
}

/** rename-template branch with the id sentinel (fields shape is a plain
 * object). pass-8 blocker 1: the PREVIEW candidate carries the EXTERNAL
 * alias contract (src- handles) — the preview resolves them against the
 * target's authoritative key set before execution; storage stays stable-key. */
const AiRenameTemplateSchema = RenameTemplateOpFieldsSchema.omit({ id: true }).safeExtend({
  id: GENERATED_OPERATOR_ID,
  sourceAliases: ExternalSourceAliasesSchema.default({}),
});

/**
 * AI-facing operator spec — the real operator branches with `id` omitted, so
 * the model never has to invent stable ids. We materialise the id server-side
 * (new uuid on add, preserved on update). Kept in lock-step with
 * schemas/operator.ts; adding an operator kind means adding a branch here too.
 */
const AiOperatorSchema = z
  .discriminatedUnion('kind', [
    withGeneratedOperatorId(FilterRegexOpSchema),
    withGeneratedOperatorId(FilterUselessOpSchema),
    withGeneratedOperatorId(RenameRegexOpSchema),
    withGeneratedOperatorId(FlagEmojiOpSchema),
    withGeneratedOperatorId(FilterTypeOpSchema),
    withGeneratedOperatorId(SortOpSchema),
    withGeneratedOperatorId(SetPropOpSchema),
    withGeneratedOperatorId(DedupOpSchema),
    withGeneratedOperatorId(FilterRegionOpSchema),
    // pass-7 blocker 3: rename-template is NOT a generic operator — the
    // profile-bound naming apply service is its only mutation gate.
  ])
  .describe(
    '一个节点处理算子。kind 之一：filter-regex 正则过滤(mode keep/drop + pattern) / ' +
      'filter-useless 去无用节点(extra 额外关键词) / rename-regex 正则重命名(pattern + replacement，空 replacement=删除匹配) / ' +
      'flag-emoji 国旗(action add/remove，tw2cn 台湾用中国旗) / filter-type 类型过滤(mode + types) / ' +
      'sort 排序(by name/type/server/region + order) / set-prop 设属性(udp/tfo/skipCertVerify) / ' +
      'dedup 去重(by name/server-port + action drop/rename) / filter-region 地区过滤(mode + regions 如 HK/JP/US)。' +
      '不用给 id。rename-template(名称统一)不在通用算子范围内——只能在「智能命名」页面修改。',
  );
/** Read-only preview candidate schema — rename-template MAY be previewed
 * here (nothing is written; the mutation inputs above reject it), so the
 * generic preview keeps working for pipelines that carry a naming step. */
const AiPreviewOperatorSchema = z.discriminatedUnion('kind', [
  ...(AiOperatorSchema.options as unknown as Parameters<typeof z.discriminatedUnion>[1]),
  AiRenameTemplateSchema,
]);
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
  operators: StoredOperator[];
  /** pass-8 blocker 1: the entity's AUTHORITATIVE source-key set. */
  keys: string[];
  /** Raw+decoded dual-view snapshot — the mutation policy's input. */
  snapshot: OperatorSnapshot;
  save(next: StoredOperator[]): Promise<void>;
}

/** Write actions refuse sources whose history contains undecodable steps. */
function assertNoParkedOperators(handle: SourceHandle): void {
  if (handle.operators.some(isParkedOperator)) {
    throw ProblemDetailsError.badRequest(
      '该来源包含无法解码的历史步骤，请先在「节点处理」页面检查并处理后重试。',
    );
  }
}

/**
 * Handle input shape: `op-` + 16 hex chars. Constrained so a syntactically
 * invalid value is rejected at the schema boundary and never echoed.
 */
export const OPERATOR_HANDLE_RE = /^op-[0-9a-f]{16}$/;

const OPERATOR_HANDLE_SCHEMA = z.string().regex(OPERATOR_HANDLE_RE, '算子句柄格式不正确');

/** Fixed, credential-free rejection — NEVER echoes the supplied value. */
const STALE_HANDLE_ERROR = '算子句柄不存在或已失效，请重新 list_node_sources 后重试。';

/** Resolve a handle to its operator index; unknown/stale handles reject
 * safely. ONE collision-checked index over the ENTIRE stored operator list
 * (parked rows included) — a MAC collision fails the bounded error, never a
 * first-match pick. */
function resolveHandle(operators: StoredOperator[], handle: string): number {
  const scope = buildOperatorScope(operators.map((op) => op.id));
  const matched = scope.resolve(handle);
  if (matched === null) {
    throw ProblemDetailsError.badRequest(STALE_HANDLE_ERROR);
  }
  return operators.findIndex((op) => op.id === matched);
}

/** Profile-bound source resolution (pass-7 blocker 3): every generic
 * preview/write resolves the model-supplied ref through the AUTHORITATIVE
 * caller-visible set — absent profile, no-source profile, unbound/foreign
 * targets and ambiguous refs all fail the same bounded non-oracle error
 * before ANY repository read of the target. */
async function resolveSource(
  ctx: ActionContext,
  sourceType: 'subscription' | 'collection',
  ref: string,
): Promise<{ type: 'subscription' | 'collection'; id: string }> {
  const profile = await requireCallerProfile(ctx.profileId);
  const visible = await callerVisibleNamingTargets(profile);
  return resolveRefInVisibleSet(ctx.profileId, sourceType, ref, visible);
}

async function loadSource(
  ctx: ActionContext,
  sourceType: 'subscription' | 'collection',
  ref: string,
): Promise<SourceHandle> {
  const { type, id } = await resolveSource(ctx, sourceType, ref);
  if (type === 'subscription') {
    const sub = await getSubscription(id);
    if (!sub) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    return {
      type,
      id,
      label: sub.display_name || sub.name,
      operators: sub.operators ?? [],
      keys: [sub.name],
      snapshot: buildOperatorSnapshot(sub),
      save: async (next) => {
        // Parked items are guarded before any write; the schema re-validates
        // the list at the service boundary either way.
        await patchSubscription(id, { operators: next as Operator[] });
      },
    };
  }
  const col = await getCollection(id);
  if (!col) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  const memberSubs = enabledCollectionMemberSubs(col, await listSubscriptions());
  return {
    type,
    id,
    label: col.name,
    operators: col.operators ?? [],
    keys: memberSubs.map((m) => m.name),
    snapshot: buildOperatorSnapshot(col),
    save: async (next) => {
      await patchCollection(id, { operators: next as Operator[] });
    },
  };
}

/**
 * Fetch the source's *raw* (pre-operator) node list for a dry-run. A dry-run
 * must never mutate shared cache state (`writeCache: false`) — same rule as
 * the workbench preview endpoints.
 */
async function sourceRawProxies(
  handle: SourceHandle,
  noCache: boolean,
  deferUniqueNames = false,
): Promise<{
  proxies: ClashProxy[];
  memberErrors?: unknown[];
  ordinalPlanningSession?: OrdinalPlanningSession;
}> {
  if (handle.type === 'subscription') {
    const sub = await getSubscription(handle.id);
    if (!sub) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    const { proxies } = await resolveSubscriptionProxiesRaw(sub, {
      noCache,
      writeCache: false,
      // The candidate pipeline drives uniqueness deferral: a draft that adds
      // managed naming may preview duplicate raw names it would repair.
      deferUniqueNames,
    });
    // Provenance parity with the workbench preview: the rename-template
    // operator reads the SAME single-subscription identity here, so source
    // labels + per-source numbering match workbench preview / normal render /
    // export. The symbol never serializes into action results.
    const identity = { key: sub.name, label: sub.display_name?.trim() || sub.name };
    const withIdentity = proxies.map((p) => withRawIdentity(p, identity)) as ClashProxy[];
    const ordinalPlanningSession = await createOrdinalPlanningSession([sub.name]);
    ordinalPlanningSession.registerSourceDomain(withIdentity, () => identity);
    return { proxies: withIdentity, ordinalPlanningSession };
  }
  const col = await getCollection(handle.id);
  if (!col) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  const subs = await listSubscriptions();
  const { merged, memberErrors, ordinalPlanningSession } = await mergeCollectionMemberProxies(
    col,
    subs,
    {
      noCache,
      writeCache: false,
    },
  );
  return { proxies: merged as ClashProxy[], memberErrors, ordinalPlanningSession };
}

/**
 * AI-action name payload: node names can embed credential-like text and these
 * results re-enter the assistant loop, so every name is REDACTED + bounded
 * (the authenticated workbench preview keeps its raw names via
 * lib/services/pipelinePreview).
 */
function redactedNamesPayload(proxies: ClashProxy[]): {
  count: number;
  names: string[];
  truncated: boolean;
} {
  const names = proxies.slice(0, NAME_CAP).map((p) => {
    const raw = typeof p.name === 'string' ? p.name : '';
    const redacted = redactSensitiveText(raw).replace(/\s+/g, ' ').trim();
    return (redacted === '' ? '(已脱敏)' : redacted).slice(0, 64);
  });
  return { count: proxies.length, names, truncated: proxies.length > NAME_CAP };
}

/** Redact + bound ANY string for AI-facing outputs. */
function safeText(text: string, fallback = '(未命名)'): string {
  const redacted = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  return (redacted === '' ? fallback : redacted).slice(0, 64);
}

/** Redact + bound a source label for AI-facing outputs (labels may contain sensitive text). */
function safeLabel(label: string): string {
  return safeText(label, '(未命名)').slice(0, 48);
}

/**
 * AI-safe step projection: engine steps carry redacted samples already, but
 * collision names are raw — every string field is re-projected through
 * safeText instead of spreading the raw step object.
 */
function safeStep(
  stepsSourceScope: TypedHandleScope<string>,
  step: {
    id: string;
    kind: string;
    applied: boolean;
    before: number;
    after: number;
    dropped: number;
    changed: number;
    collisions?: string[];
    deduped?: Array<{ kept: string; dropped: string; sourceKey?: string }>;
    samples?: { before: string; after: string }[];
  },
): unknown {
  return {
    id: step.id,
    kind: step.kind,
    applied: step.applied,
    before: step.before,
    after: step.after,
    dropped: step.dropped,
    changed: step.changed,
    ...(step.collisions && step.collisions.length > 0
      ? { collisions: step.collisions.map((c) => safeText(c, '(已脱敏)')) }
      : {}),
    ...(step.deduped && step.deduped.length > 0
      ? {
          deduped: step.deduped.map((d) => ({
            kept: safeText(d.kept, '(已脱敏)'),
            dropped: safeText(d.dropped, '(已脱敏)'),
            // pass-7 blocker 1: stable source keys never reach the model —
            // keyed src handles only, projected through ONE complete-domain
            // source scope over every step's source keys (round-2)
            ...(d.sourceKey !== undefined
              ? { sourceKey: stepsSourceScope.project(d.sourceKey) }
              : {}),
          })),
        }
      : {}),
    ...(step.samples && step.samples.length > 0
      ? {
          samples: step.samples.map((sample) => ({
            before: safeText(sample.before, '(已脱敏)'),
            after: safeText(sample.after, '(已脱敏)'),
          })),
        }
      : {}),
  };
}

/** AI-safe reference projection — node + via can carry user/sensitive text. */
function safeReference(ref: { node: string; kind: string; via: string }): unknown {
  return {
    node: safeText(ref.node, '(已脱敏)'),
    kind: ref.kind,
    via: safeText(ref.via, '(已脱敏)'),
  };
}

/** AI-safe member-error projection — the error string may echo upstream hosts. */
function safeMemberError(member: unknown): unknown {
  const name =
    member !== null && typeof member === 'object' && 'name' in member
      ? String((member as { name: unknown }).name ?? '')
      : '';
  const error =
    member !== null && typeof member === 'object' && 'error' in member
      ? String((member as { error: unknown }).error ?? '')
      : '';
  return {
    name: safeText(name, '(未命名)'),
    error: safeText(error, '(未知错误)').slice(0, 120),
  };
}

/**
 * Shared list contract for AI-built pipelines: bounded max + at-most-one
 * rename-template, exactly like every write/preview path. Throws a safe,
 * actionable ProblemDetailsError.
 */
function assertSharedListContract(ops: StoredOperator[]): void {
  // Parked placeholders are rejected by the guard before any write; this
  // re-check runs the shared schema over the executable subset.
  const parsed = OperatorListSchema.safeParse(ops.filter(isExecutableOperator));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? '算子列表不合法';
    throw ProblemDetailsError.badRequest(`算子列表不合法：${message}`);
  }
}

/* ─── diff / result helpers ─────────────────────────────────────────── */

/** Credential-free structural projection for write-preview diffs: only
 * id/kind/disabled — NEVER regex text, replacements or alias tables. */
function safeOpsProjection(
  ops: StoredOperator[],
): Array<{ handle: string; kind: string; disabled?: boolean }> {
  // round-1: ONE collision-checked index over the FULL operator domain
  // BEFORE projection — ambiguous op handles never reach a confirmation diff
  const scope = buildOperatorScope(ops.map((op) => op.id));
  return ops.map((op) => ({
    handle: scope.project(op.id),
    kind: op.kind,
    ...(op.disabled ? { disabled: true as const } : {}),
  }));
}

function opsDiff(handle: SourceHandle, before: StoredOperator[], after: StoredOperator[]): unknown {
  const bucket = handle.type === 'subscription' ? 'subscriptions' : 'collections';
  return {
    op: 'update',
    path: `${bucket}[${safeLabel(handle.label)}].operators`,
    beforeCount: before.length,
    afterCount: after.length,
    before: safeOpsProjection(before),
    after: safeOpsProjection(after),
  };
}

function writeResult(op: string, summary: string, data: unknown): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events: [] } };
}

function insertAt(arr: StoredOperator[], op: Operator, pos?: number): StoredOperator[] {
  const next = [...arr];
  if (pos === undefined || pos >= next.length) next.push(op);
  else next.splice(Math.max(0, pos), 0, op);
  return next;
}

function sourceLabel(t: 'subscription' | 'collection'): string {
  return t === 'subscription' ? '订阅源' : '聚合订阅';
}

/* ─── list_node_sources ─────────────────────────────────────────────── */

/**
 * Bounded credential-free operator projection for the assistant: opaque
 * handles + kind + state only. NEVER raw operator objects — ids, regex
 * patterns, replacements and sourceAliases must not re-enter the loop.
 */
function safeOperatorProjection(ops: StoredOperator[]): Array<{
  handle: string;
  kind: string;
  disabled?: boolean;
  compatibility_issue?: string;
}> {
  // round-1: ONE collision-checked index over the FULL operator domain
  // BEFORE projection — two ids mapping to one handle fails closed before
  // any ambiguous row is emitted (no cap/slice bypass)
  const scope = buildOperatorScope(ops.map((op) => op.id));
  return ops.map((op) => ({
    handle: scope.project(op.id),
    kind: op.kind,
    ...(op.disabled ? { disabled: true as const } : {}),
    ...(isParkedOperator(op) ? { compatibility_issue: op.compatibility_issue } : {}),
  }));
}

const listNodeSources = defineAction({
  name: 'list_node_sources',
  description:
    '列出全部订阅源(subscription)与聚合订阅(collection)及其「节点处理」算子管线。每个源含 type/id(增删改算子时用)/name/slug/enabled，以及 operators 数组(每个算子含 handle/kind/disabled；handle 是稳定的不透明句柄，update/delete/reorder 时用 handle 指代算子，不要自行拼造)。要管理算子(过滤/重命名/去重/排序/加国旗等)、或在 add/update/delete/reorder_operator 前拿 source id 与算子 handle 时调用。只读，不含节点密码 / 订阅 URL / 正则原文。',
  input: z.object({}),
  risk: 'read',
  async run(ctx) {
    // pass-7 blocker 3: list ONLY the caller-visible set (profile source
    // binding) and expose profile-bound opaque refs — raw source UUIDs and
    // slugs never cross the model boundary.
    const profile = await requireCallerProfile(ctx.profileId);
    const visible = await callerVisibleNamingTargets(profile);
    const visibleSubIds = new Set(
      visible.filter((t) => t.type === 'subscription').map((t) => t.id),
    );
    const visibleColIds = new Set(visible.filter((t) => t.type === 'collection').map((t) => t.id));
    const [subs, cols] = await Promise.all([listSubscriptions(), listCollections()]);
    // round-2: ONE collision-checked target scope over the COMPLETE visible
    // union — every emitted ref is projected through it, never freshly minted
    const targetScope = buildTargetRefScope(ctx.profileId, visible);
    return {
      kind: 'node-sources',
      data: {
        subscriptions: subs
          .filter((s) => visibleSubIds.has(s.id))
          .map((s) => ({
            ref: targetScope.project(`subscription:${s.id}`),
            name: safeLabel(s.display_name || s.name),
            enabled: s.enabled,
            kind: s.kind,
            operatorCount: s.operators.length,
            operators: safeOperatorProjection(s.operators),
          })),
        collections: cols
          .filter((c) => visibleColIds.has(c.id))
          .map((c) => ({
            ref: targetScope.project(`collection:${c.id}`),
            name: safeLabel(c.name),
            enabled: c.enabled,
            operatorCount: c.operators.length,
            operators: safeOperatorProjection(c.operators),
          })),
      },
    };
  },
});

/* ─── preview_node_operators ────────────────────────────────────────── */

/** Profile-bound opaque source ref — raw source UUIDs/slugs never enter the
 * generic operator loop (pass-7 blocker 3). */
const SourceRefInput = z.object({
  source_type: SourceType,
  ref: z
    .string()
    .regex(NAMING_REF_RE, '目标引用格式不正确(先用 list_node_sources 拿 ref)')
    .describe('不透明目标引用(先用 list_node_sources 拿)'),
});

const PreviewInput = SourceRefInput.extend({
  operators: z
    .array(AiPreviewOperatorSchema)
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
    const handle = await loadSource(ctx, input.source_type, input.ref);
    // pass-8 blocker 1: preview candidates carry EXTERNAL src- handles —
    // translate them through the target's authoritative key set before any
    // execution; invented/ambiguous/duplicate keys fail the bounded error.
    const ops: Operator[] = input.operators.map((spec, i): Operator => {
      // The preview schema is the validated superset of the mutation union
      // (it adds the read-only rename-template branch); materialize()'s
      // parameter type is the narrower union, so the boundary cast is the
      // schema-validated bridge — OperatorSchema.parse accepts both.
      const previewSpec = spec as unknown as AiOperator;
      const materialized = materialize(previewSpec, `preview-${i}`);
      if (materialized.kind !== 'rename-template') return materialized;
      return {
        ...materialized,
        sourceAliases: resolveSourceAliasKeys(materialized.sourceAliases, handle.keys) ?? {},
      };
    });
    assertSharedListContract(ops);
    const deferUniqueNames = ops.some(isActiveCurrentRenameTemplateOperator);
    const {
      proxies: before,
      memberErrors,
      ordinalPlanningSession,
    } = await sourceRawProxies(handle, input.no_cache === true, deferUniqueNames);
    // Read-only ordinal snapshot: previews never publish numbering state.
    const managedOp = ops.find(isActiveCurrentRenameTemplateOperator);
    const ordinals = await resolveOrdinalsFor(before, sourceOf, {
      persist: false,
      template: managedOp?.template,
      recognitionRules: managedOp?.recognitionRules ?? [],
      planningSession: ordinalPlanningSession,
      domainRegistry: ordinalPlanningSession,
    });
    const { proxies: after, steps } = applyOperators(before, ops, ordinals);

    // Names present before but gone after = renamed-or-dropped. If any was
    // pinned by a chain backend / proxy-group member / rule, the pipeline would
    // orphan that reference (and a chain backend orphan crashes mihomo on load).
    const beforeNames = before.map((p) => (typeof p.name === 'string' ? p.name : ''));
    const afterNames = new Set(after.map((p) => (typeof p.name === 'string' ? p.name : '')));
    const disappeared = [...new Set(beforeNames)].filter((n) => n && !afterNames.has(n));
    const orphanedReferences = await findNodeReferences(ctx.profileId, disappeared);

    // round-2: ONE source scope over the COMPLETE source-key domain of every
    // step's dedup diagnostics before any projection
    const stepsSourceScope = buildSourceAliasScope(
      steps.flatMap((step) =>
        (step.deduped ?? []).flatMap((d) => (d.sourceKey !== undefined ? [d.sourceKey] : [])),
      ),
    );
    return {
      kind: 'node-operators-preview',
      data: {
        source: safeLabel(handle.label),
        sourceType: handle.type,
        before: redactedNamesPayload(before),
        after: redactedNamesPayload(after),
        steps: steps.map((step) => safeStep(stepsSourceScope, step)),
        ...(memberErrors && memberErrors.length
          ? { memberErrors: memberErrors.map(safeMemberError) }
          : {}),
        orphanedReferences: orphanedReferences.map(safeReference),
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

const AddInput = SourceRefInput.extend({
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
  async preview(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const next = insertAt(handle.operators, materialize(input.operator, 'new'), input.position);
    assertSharedListContract(next);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const op = materialize(input.operator, crypto.randomUUID());
    const next = insertAt(handle.operators, op, input.position);
    assertSharedListContract(next);
    await handle.save(next);
    // round-2: the new handle is projected through ONE operator scope over
    // the post-write pipeline (never a fresh single mint)
    const resultScope = buildOperatorScope(next.map((o) => o.id));
    return writeResult('update', `已给 ${safeLabel(handle.label)} 新增算子 ${op.kind}`, {
      ref: input.ref,
      operatorHandle: resultScope.project(op.id),
      count: next.length,
    });
  },
});

/* ─── update_operator ───────────────────────────────────────────────── */

const UpdateInput = SourceRefInput.extend({
  operator_handle: OPERATOR_HANDLE_SCHEMA.describe(
    '要修改算子的不透明句柄(用 list_node_sources 拿)',
  ),
  operator: AiOperatorSchema.describe(
    '该算子的新完整定义(不用给 id，沿用原 id)。整条替换：可借此换 kind 或改任意参数',
  ),
});

const updateOperator = defineWriteAction({
  name: 'update_operator',
  description:
    '修改算子管线里某一个步骤(按 operator_handle 定位，整条替换为你给的新定义，位置与 handle 不变)。需用户确认。改正则前先用 preview_node_operators 验证。先用 list_node_sources 拿 source id 与算子 handle。',
  input: UpdateInput,
  risk: 'write',
  summary: (i) => `修改${sourceLabel(i.source_type)}的算子 → ${i.operator.kind}`,
  async preview(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const idx = resolveHandle(handle.operators, input.operator_handle);
    const op = handle.operators[idx];
    // pass-10 blocker 2: no pre-guard fork — the candidate goes through the
    // SAME current-vs-candidate invariant at the service boundary (touching
    // a naming row fails the one dedicated gate error before any write)
    const next = [...handle.operators];
    next[idx] = materialize(input.operator, op.id);
    assertSharedListContract(next);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const idx = resolveHandle(handle.operators, input.operator_handle);
    const op = handle.operators[idx];
    const next = [...handle.operators];
    next[idx] = materialize(input.operator, op.id);
    assertSharedListContract(next);
    await handle.save(next);
    return writeResult('update', `已修改 ${safeLabel(handle.label)} 的算子 ${next[idx].kind}`, {
      ref: input.ref,
      operatorHandle: input.operator_handle,
    });
  },
});

/* ─── delete_operator ───────────────────────────────────────────────── */

const DeleteInput = SourceRefInput.extend({
  operator_handle: OPERATOR_HANDLE_SCHEMA.describe(
    '要删除算子的不透明句柄(用 list_node_sources 拿)',
  ),
});

const deleteOperator = defineWriteAction({
  name: 'delete_operator',
  description:
    '从算子管线里删除一个步骤(按 operator_handle)。需用户确认。先用 list_node_sources 拿 source id 与算子 handle。',
  input: DeleteInput,
  risk: 'write',
  summary: (i) => `删除${sourceLabel(i.source_type)}的一个算子`,
  async preview(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const idx = resolveHandle(handle.operators, input.operator_handle);
    const next = handle.operators.filter((_, i) => i !== idx);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const idx = resolveHandle(handle.operators, input.operator_handle);
    const removed = handle.operators[idx];
    const next = handle.operators.filter((_, i) => i !== idx);
    await handle.save(next);
    return writeResult('update', `已从 ${safeLabel(handle.label)} 删除算子 ${removed.kind}`, {
      ref: input.ref,
      operatorHandle: input.operator_handle,
      count: next.length,
    });
  },
});

/* ─── reorder_operators ─────────────────────────────────────────────── */

const ReorderInput = SourceRefInput.extend({
  operator_handles: z
    .array(OPERATOR_HANDLE_SCHEMA)
    .min(1)
    .describe('管线里全部算子 handle 的新顺序——必须是现有算子 handle 的一个全排列(不多不少)'),
});

/** Reorder by a full permutation of existing handles; reject partial/unknown sets. */
function reordered(current: StoredOperator[], orderedHandles: string[]): StoredOperator[] {
  if (
    orderedHandles.length !== current.length ||
    new Set(orderedHandles).size !== orderedHandles.length
  ) {
    throw ProblemDetailsError.badRequest(
      'operator_handles 必须是现有算子 handle 的一个全排列(不重复、不多不少)。',
    );
  }
  // round-1: collision-checked index over the FULL operator domain — two ids
  // mapping to one handle fails closed before any mapping
  const scope = buildOperatorScope(current.map((o) => o.id));
  const byHandle = new Map<string, StoredOperator>();
  for (const op of current) {
    const handle = scope.project(op.id);
    if (handle !== undefined) byHandle.set(handle, op);
  }
  const next: StoredOperator[] = [];
  for (const handle of orderedHandles) {
    const op = byHandle.get(handle);
    if (!op) {
      throw ProblemDetailsError.badRequest(STALE_HANDLE_ERROR);
    }
    next.push(op);
  }
  return next;
}

const reorderOperators = defineWriteAction({
  name: 'reorder_operators',
  description:
    '重排算子管线的执行顺序(算子按顺序依次作用，顺序会影响结果，比如「先重命名再过滤」与「先过滤再重命名」不同)。需用户确认。operator_handles 要给该源全部算子 handle 的新排列。先用 list_node_sources 拿 handle。',
  input: ReorderInput,
  risk: 'write',
  summary: (i) => `重排${sourceLabel(i.source_type)}的算子顺序`,
  async preview(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const next = reordered(handle.operators, input.operator_handles);
    // pass-9 blocker 2: the SHARED current-vs-candidate invariant — the
    // mutation policy rejects naming-row creation/touch/delete and any move
    // across a surviving operator (a numeric index shift from inserting or
    // deleting non-name rows is NOT a move and passes).
    assertGenericNamingRowsInvariant(handle.snapshot, next);
    return { diff: opsDiff(handle, handle.operators, next) };
  },
  async execute(ctx, input) {
    const handle = await loadSource(ctx, input.source_type, input.ref);
    assertNoParkedOperators(handle);
    const next = reordered(handle.operators, input.operator_handles);
    assertGenericNamingRowsInvariant(handle.snapshot, next);
    await handle.save(next);
    return writeResult('update', `已重排 ${safeLabel(handle.label)} 的算子顺序`, {
      ref: input.ref,
      order: input.operator_handles,
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
