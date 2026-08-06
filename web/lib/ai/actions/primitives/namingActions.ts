/**
 * Composable naming agent — the 智能命名 assistant loop (criterion 9).
 *
 * Capabilities (names are the registry's tool names):
 *   - list_naming_targets          list naming targets + managed state
 *   - inspect_naming_fields        field catalog + per-source coverage matrix
 *   - inspect_source_name_clusters sanitized name-pattern clusters (+ bounded
 *                                  extra samples for one selected cluster)
 *   - inspect_naming_collisions    collisions + true-dedup + name references
 *   - inspect_node_parse           one OPAQUE node's typed parse
 *   - preview_naming_recognition   a source-recognition candidate over all nodes
 *   - inspect_naming_drift         drifted patterns (near-miss signals)
 *   - preview_naming_target        complete template + policy preview (round-trip)
 *   - save_naming_plan             ONE confirmation-gated, CAS-protected write
 *
 * The AI can iterate the read/preview tools freely; every render-affecting
 * write goes through the existing confirmation handshake and the shared
 * save gate (patchSubscription / patchCollection). Candidates round-trip BY
 * VALUE between preview_naming_target and save_naming_plan — no server-side
 * draft state exists, so an abandoned candidate can never affect serving.
 *
 * Privacy (criterion 10): every string that re-enters the loop is projected
 * through redaction + bounds (names, labels, fragments, errors). Node handles
 * are keyed HMAC-SHA256 opaque tokens. Raw operator rows, subscription URLs, server/IP/
 * port, credentials, SNI, headers and fingerprints never appear; templates
 * and bounded recognition rules are the managed config itself and are safe.
 */

import { z } from '@/lib/openapi/zod';
import { ExternalSourceAliasesSchema } from '@/schemas/externalAliases';
import {
  buildNodeSnapshotScope,
  nodeIdentityOf,
  sanitizeDisplayText,
} from '@/lib/ai/namingContextProjection';
import {
  buildSourceAliasScope,
  buildTargetRefScope,
  type TypedHandleScope,
} from '@/lib/proxies/handleScopes';
import { resolveSourceAliasKeys } from '@/lib/services/sourceAliasResolver';
import {
  callerVisibleNamingTargets,
  captureNamingMembership,
  NAMING_SCOPE_ERROR,
  requireCallerProfile,
  resolveRefInVisibleSet,
} from '@/lib/services/namingTargetScope';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  applyRenameTemplate,
  defaultTemplateFor,
  recognizeName,
  summarizeTemplate,
  validateTemplate,
  type OrdinalResolver,
  type RecognitionRule,
} from '@/lib/proxies/naming';
import { analyzeSourceFacts, type SourceHealthReport } from '@/lib/proxies/namingHealth';
import { canonicalProxyType, redactSensitiveText } from '@/lib/proxies/namingSanitize';
import type { ClashProxy } from '@/lib/proxies/operators';
import { sourceOf } from '@/lib/proxies/provenance';
import { withRawIdentity } from '@/lib/proxies/naming';
import {
  createOrdinalPlanningSession,
  resolveOrdinalsFor,
  type OrdinalPlanningSession,
} from '@/lib/services/nodeOrdinalService';
import { mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { getCollection } from '@/lib/services/collectionService';
import { getSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { applyNamingPlan } from '@/lib/services/namingApplyService';
import { completeNamingPlan, priorPolicyOf } from '@/lib/services/namingManagedCandidate';
import { namingCandidateForEntity } from '@/lib/services/namingPreviewService';
import { buildOperatorSnapshot } from '@/lib/repos/rawOperators';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { findNodeReferences } from '@/lib/services/nodeReferenceService';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getProfile } from '@/lib/repos/profilesRepo';
import {
  isActiveCurrentRenameTemplateOperator,
  RecognitionRuleSchema,
  type Operator,
} from '@/schemas';
import { defineAction, defineWriteAction, type ActionContext, type WritePreview } from '../types';

/** Deterministic AI-output caps (pass-3 finding): a 50000-node source must
 * never return bulk arrays — every list is capped with the deterministic
 * TOTAL count + an explicit truncated flag. */
const MAX_COLLISIONS = 100;
const MAX_PARTICIPANTS = 8;
const MAX_DEDUPED = 200;
const MAX_ORPHANED = 100;
const MAX_CLUSTERS = 20;
const MAX_TARGETS = 100;
const MAX_SOURCES = 20;
const MAX_DRIFT = 40;

function capList<T>(items: T[], cap: number): { items: T[]; total: number; truncated: boolean } {
  return {
    items: items.slice(0, cap),
    total: items.length,
    truncated: items.length > cap,
  };
}

/* ─── privacy projections (round-1: useful sanitized display content) ─── */

/** Redact + bound ANY string for AI-facing outputs. */
function safeText(text: string, fallback = '(未命名)'): string {
  const redacted = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  return (redacted === '' ? fallback : redacted).slice(0, 64);
}

/** Fields a recognition rule targets — their values are rule-authored free
 * text; round-1 (invariant 6): SAFE current/candidate recognition-rule text
 * IS authorized display content — sanitized, never tokenized. */
function ruleTargetedFields(rules: readonly RecognitionRule[] | undefined): ReadonlySet<string> {
  return new Set((rules ?? []).map((r) => r.field));
}

const NODE_HANDLE_RE = /^nd-[0-9a-f]{16}$/;
const NODE_HANDLE_SCHEMA = z.string().regex(NODE_HANDLE_RE, '节点句柄格式不正确');
const STALE_NODE_HANDLE_ERROR = '节点句柄不存在或已失效，请重新获取节点样本。';

const SourceType = z
  .enum(['subscription', 'collection'])
  .describe('源类型：subscription 普通订阅源 / collection 聚合订阅');

const REF_RE = /^ref-[0-9a-f]{16}$/;
const SourceRef = z.object({
  source_type: SourceType,
  ref: z
    .string()
    .regex(REF_RE, '目标引用格式不正确(先用 list_naming_targets 拿 ref)')
    .describe('不透明目标引用(先用 list_naming_targets 拿)——绝不传原始 UUID'),
});

/** Resolve a model-supplied ref through the AUTHORITATIVE caller-visible
 * scope (pass-6 blocker 1): the caller's profile is loaded and its CURRENT
 * source binding decides the visible set — an absent profile or an unbound
 * target resolves to NOTHING. All exact matches inside the visible set are
 * collected and exactly one is accepted; zero, multiple, wrong-kind and
 * unauthorized share one bounded non-oracle error. */
async function resolveTargetByRef(
  ctx: ActionContext,
  sourceType: 'subscription' | 'collection',
  ref: string,
): Promise<{ type: 'subscription' | 'collection'; id: string }> {
  const profile = await requireCallerProfile(ctx.profileId);
  const visible = await callerVisibleNamingTargets(profile);
  return resolveRefInVisibleSet(ctx.profileId, sourceType, ref, visible);
}

const TemplateSchema = z
  .string()
  .min(1, '模板不能为空')
  .max(512, '模板过长')
  .superRefine((template, ctx) => {
    const validation = validateTemplate(template);
    if (!validation.ok) ctx.addIssue({ code: 'custom', message: validation.message });
  });

const RecognitionRulesSchema = z.array(RecognitionRuleSchema).max(32).default([]);

/* ─── source helpers ───────────────────────────────────────────────── */

interface RawSource {
  type: 'subscription' | 'collection';
  id: string;
  label: string;
  proxies: ClashProxy[];
  /** Active rename-template op, when one exists. */
  renameOp?: Operator & { kind: 'rename-template' };
  aggregate: boolean;
  /** pass-8 blocker 1: the entity's AUTHORITATIVE source-key set — the only
   * keys external src- handles may resolve to. */
  keys: string[];
  ordinalPlanningSession: OrdinalPlanningSession;
}

async function loadRawSource(
  ctx: ActionContext,
  input: z.infer<typeof SourceRef>,
): Promise<RawSource> {
  // The ref is the ONLY identity the model supplies — resolve it through the
  // profile-bound authorized keyed resolver, never by raw UUID.
  const { type, id } = await resolveTargetByRef(ctx, input.source_type, input.ref);
  if (type === 'subscription') {
    const sub = await getSubscription(id);
    if (!sub) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    const { proxies } = await resolveSubscriptionProxiesRaw(sub, { writeCache: false });
    const identity = { key: sub.name, label: sub.display_name?.trim() || sub.name };
    const ordinalPlanningSession = await createOrdinalPlanningSession([sub.name]);
    const withIdentity = proxies.map((p) => withRawIdentity(p, identity)) as ClashProxy[];
    ordinalPlanningSession.registerSourceDomain(withIdentity, () => identity);
    const renameOp = (sub.operators ?? []).find(isActiveCurrentRenameTemplateOperator);
    return {
      type: 'subscription',
      id,
      label: sub.display_name?.trim() || sub.name,
      proxies: withIdentity,
      renameOp,
      aggregate: false,
      keys: [sub.name],
      ordinalPlanningSession,
    };
  }
  const col = await getCollection(id);
  if (!col) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  const subs = await listSubscriptions();
  const { merged, ordinalPlanningSession } = await mergeCollectionMemberProxies(col, subs, {
    writeCache: false,
  });
  const planningSession =
    ordinalPlanningSession ??
    (await createOrdinalPlanningSession(
      enabledCollectionMemberSubs(col, subs).map((member) => member.name),
    ));
  if (!ordinalPlanningSession) planningSession.registerSourceDomain(merged, sourceOf);
  const renameOp = (col.operators ?? []).find(isActiveCurrentRenameTemplateOperator);
  return {
    type: 'collection',
    id,
    label: col.name,
    proxies: merged as ClashProxy[],
    renameOp,
    aggregate: true,
    keys: enabledCollectionMemberSubs(col, subs).map((m) => m.name),
    ordinalPlanningSession: planningSession,
  };
}

/** Read-only ordinal snapshot — previews never publish numbering state.
 * The CANDIDATE template + recognition rules drive the upstream-ordinal skip
 * (exactly the executor's semantics): an unsaved candidate must never be
 * numbered with the SAVED plan's semantics (C6). */
async function readOnlyOrdinals(
  source: RawSource,
  template?: string,
  recognitionRules?: RecognitionRule[],
): Promise<OrdinalResolver> {
  return resolveOrdinalsFor(source.proxies, sourceOf, {
    persist: false,
    template: template ?? source.renameOp?.template,
    recognitionRules: recognitionRules ?? source.renameOp?.recognitionRules ?? [],
    planningSession: source.ordinalPlanningSession,
    domainRegistry: source.ordinalPlanningSession,
  });
}

/** Per-source health reports, projected for the loop (round-1: useful
 * sanitized display text + complete-domain node/source scopes). */
function projectHealth(
  reports: SourceHealthReport[],
  nodeScope: TypedHandleScope<string>,
  ruleTargets: ReadonlySet<string> = new Set(),
): Array<{
  source: string;
  nodeCount: number;
  fields: Array<{
    field: string;
    label: string;
    present: number;
    total: number;
    percent: number;
    confidence: { high: number; medium: number; low: number };
    samples: Array<{ value: string; count: number; kind: string; confidence: string }>;
    sampleTotal: number;
    sampleTruncated: boolean;
  }>;
  nodeFacts: Array<{
    node: string;
    field: string;
    value: string | null;
    confidence: string | null;
    kind: string | null;
    ambiguous: boolean;
  }>;
  nodeFactsTotal: number;
  nodeFactsTruncated: boolean;
  unavailable: string[];
  partial: string[];
  ambiguousCount: number;
  drift: Array<{ field: string; count: number; samples: string[]; samplesTruncated: boolean }>;
}> {
  void ruleTargets;
  /** Canonical protocol enums stay useful; ANY other type is dropped —
   * only the shared production protocol enum may cross (invariant 9). */
  const protocolValue = (value: string): string | null => canonicalProxyType(value);
  /** Bounded sanitized display fragment — useful text survives redaction,
   * credentials never do; dropped when nothing safe remains. */
  const sampleText = (value: string): string => sanitizeDisplayText(value, 24) ?? '(已脱敏)';
  // round-1: ONE collision-checked index over the COMPLETE source-key domain
  // BEFORE any map/cap/slice — two distinct source keys mapping to one src-
  // handle fails the response closed (never a capped subset as the collision
  // domain)
  const sourceScope = buildSourceAliasScope(reports.map((r) => r.sourceKey));
  return reports.map((report) => ({
    // OPAQUE source handle — the source label/slug is raw text and never
    // serialized (pass-2 finding); projected through the complete-domain
    // collision-checked scope (round-1). The anonymous-source key ('') is a
    // first-class identity of the source scope.
    source: sourceScope.project(report.sourceKey),
    nodeCount: report.nodeCount,
    fields: report.fields.map((f) => ({
      field: f.field,
      label: f.label,
      present: f.present,
      total: f.total,
      percent: f.percent,
      confidence: f.confidence,
      samples: f.samples.slice(0, 2).map((s) => ({
        value:
          f.field === 'protocol' ? (protocolValue(s.value) ?? '(已脱敏)') : sampleText(s.value),
        count: s.count,
        kind: s.kind,
        confidence: s.confidence,
      })),
      // TRUE distinct-value totals — never the stored sample cap — and the
      // truncation flag describes the PROJECTED list (3 distinct values
      // projected to 2 ⇒ truncated=true, pass-2 finding).
      sampleTotal: f.sampleTotal,
      sampleTruncated: f.sampleTotal > 2,
    })),
    nodeFacts: report.nodeFacts.slice(0, 40).map((f) => ({
      // internal identity → collision-checked complete-domain node handle
      node: nodeScope.project(f.node),
      field: f.field,
      value:
        f.value === null
          ? null
          : f.field === 'protocol'
            ? protocolValue(f.value)
            : sampleText(f.value),
      confidence: f.confidence,
      kind: f.kind,
      ambiguous: f.ambiguous,
    })),
    // TRUE FACT-ROW totals (pass-2 finding): the totals describe the fact
    // list's semantic unit, and truncation reflects the PROJECTED length.
    nodeFactsTotal: report.nodeFactsTotal,
    nodeFactsTruncated: report.nodeFactsTruncated || report.nodeFacts.length > 40,
    unavailable: report.unavailable,
    partial: report.partial,
    ambiguousCount: report.ambiguousCount,
    drift: report.drift.map((d) => ({
      field: d.field,
      count: d.count,
      // residual fragments are name-derived display text — sanitized
      // (bounded), dropped when nothing safe remains
      samples: d.samples.map((sample) => sampleText(sample)),
      samplesTruncated: d.samplesTruncated,
    })),
  }));
}

/* ─── list_naming_targets ──────────────────────────────────────────── */

const listNamingTargets = defineAction({
  name: 'list_naming_targets',
  description:
    '列出全部命名目标(订阅源 subscription 与聚合订阅 collection)及其智能命名状态：是否已启用「名称统一」模板、当前模板字符串、是否聚合(决定推荐模板是否含来源段)。开始任何命名工作前先调用。只读，不含节点凭证 / 订阅 URL。',
  input: z.object({}),
  risk: 'read',
  async run(ctx) {
    // pass-6 blocker 1: list ONLY the caller's visible set — the CURRENT
    // profile source binding decides it; an absent profile mints no refs.
    const profile = await getProfile(ctx.profileId);
    const visible = profile ? await callerVisibleNamingTargets(profile) : [];
    const visibleSubIds = new Set(
      visible.filter((t) => t.type === 'subscription').map((t) => t.id),
    );
    const visibleColIds = new Set(visible.filter((t) => t.type === 'collection').map((t) => t.id));
    const [subs, cols] = await Promise.all([listSubscriptions(), listCollections()]);
    // round-2: ONE collision-checked target scope over the COMPLETE visible
    // union — every ref is projected through it (never a fresh single mint)
    const targetScope = buildTargetRefScope(ctx.profileId, visible);
    const projects = (
      items: Array<{
        id: string;
        label: string;
        renameOp?: Operator & { kind: 'rename-template' };
        aggregate: boolean;
      }>,
    ) =>
      items.map((item) => ({
        // Keyed PROFILE-BOUND opaque reference (pass-5 blocker): the raw
        // UUID and source label never serialize; the ref is projected under
        // the caller's authorized profile and cannot be replayed cross-profile.
        ref: targetScope.project(`${item.aggregate ? 'collection' : 'subscription'}:${item.id}`),
        // Raw DSL template strings are never serialized either — only the
        // bounded structural summary of the closed-DSL placeholder set.
        managed: item.renameOp
          ? { present: true, templateSummary: summarizeTemplate(item.renameOp.template) }
          : {
              present: false,
              recommendedTemplateSummary: summarizeTemplate(defaultTemplateFor(item.aggregate)),
            },
        aggregate: item.aggregate,
      }));
    // 50000 sources must never return 50000 rows: deterministic hard caps
    // with TRUE totals + explicit truncated flags (pass-1 finding).
    const subscriptionProjects = projects(
      subs
        .filter((s) => visibleSubIds.has(s.id))
        .map((s) => ({
          id: s.id,
          label: s.display_name?.trim() || s.name,
          renameOp: (s.operators ?? []).find(isActiveCurrentRenameTemplateOperator),
          aggregate: false,
        })),
    );
    const collectionProjects = projects(
      cols
        .filter((c) => visibleColIds.has(c.id))
        .map((c) => ({
          id: c.id,
          label: c.name,
          renameOp: (c.operators ?? []).find(isActiveCurrentRenameTemplateOperator),
          aggregate: true,
        })),
    );
    // round-1: the ref-collision check runs through ONE typed scope over the
    // COMPLETE visible target union BEFORE any cap/slice — a collision whose
    // second row lies beyond MAX_TARGETS must still fail the response closed
    // (the scope index itself fails on ambiguity).
    buildTargetRefScope(ctx.profileId, visible);
    const subsCapped = capList(subscriptionProjects, MAX_TARGETS);
    const colsCapped = capList(collectionProjects, MAX_TARGETS);
    return {
      kind: 'naming-targets',
      data: {
        totalTargets: subscriptionProjects.length + collectionProjects.length,
        subscriptions: subsCapped.items,
        totalSubscriptions: subsCapped.total,
        truncatedSubscriptions: subsCapped.truncated,
        collections: colsCapped.items,
        totalCollections: colsCapped.total,
        truncatedCollections: colsCapped.truncated,
      },
    };
  },
});

/* ─── inspect_naming_fields ────────────────────────────────────────── */

const inspectNamingFields = defineAction({
  name: 'inspect_naming_fields',
  description:
    '检查一个命名目标的字段目录与逐来源覆盖率：每个占位符(emoji/region/region_code/entry/route/vendor/source/protocol/rate/index/note)的命中数、百分比、字段类型(intrinsic 结构化 / derived 识别 / ai-rule 规则 / assigned 指派)、代表性脱敏样本；以及 unavailable(0%)、partial(部分)、ambiguous(信号冲突)与 drift(漂移)统计。聚合订阅返回每个成员来源一行(矩阵)。只读。',
  input: SourceRef,
  risk: 'read',
  async run(ctx, input) {
    const source = await loadRawSource(ctx, input);
    if (source.proxies.length === 0) {
      throw ProblemDetailsError.unprocessable('该来源当前没有节点。');
    }
    const reports = analyzeSourceFacts(source.proxies, {
      rules: source.renameOp?.recognitionRules,
    });
    const sourcesCapped = capList(
      projectHealth(
        reports,
        buildNodeSnapshotScope(source.proxies).scope,
        ruleTargetedFields(source.renameOp?.recognitionRules),
      ),
      MAX_SOURCES,
    );
    return {
      kind: 'naming-fields',
      data: {
        source: input.ref,
        aggregate: source.aggregate,
        nodeCount: source.proxies.length,
        // 50000 member reports must never return 50000 rows — bounded with
        // the TRUE report count + explicit truncation (pass-1 finding).
        sources: sourcesCapped.items,
        totalSources: sourcesCapped.total,
        truncatedSources: sourcesCapped.truncated,
      },
    };
  },
});

/* ─── inspect_source_name_clusters ─────────────────────────────────── */

const ClusterInput = z.object({
  ...SourceRef.shape,
  more_samples_for: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('请求第 N 个簇的额外脱敏样本(0 起；每次 ≤20 条，只读)'),
});

/** Structured recognition signature (pass-4 finding): typed FIELDS, never a
 * delimiter-joined string — a rule-authored value containing '|' or any
 * metacharacter can never change field boundaries or leak residue through a
 * later split. The residual token is kept only for grouping, never projected. */
interface ClusterSignature {
  region: string | null;
  route: string | null;
  vendor: string | null;
  rate: string | null;
  entry: string | null;
  residual: string;
}

function clusterSignatureOf(name: string, rules: RecognitionRule[] | undefined): ClusterSignature {
  const r = recognizeName(name, rules);
  return {
    region: r.region,
    route: r.route,
    vendor: r.vendor,
    rate: r.rate === null ? null : String(r.rate),
    entry: r.entry,
    residual: (r.base.trim().split(/\s+/)[0] ?? '').slice(0, 16),
  };
}

/** Unambiguous internal grouping key (JSON escapes delimiters/metacharacters)
 * — the signature fields are projected per-field before any serialization. */
function clusterGroupKey(sig: ClusterSignature): string {
  return JSON.stringify([sig.region, sig.route, sig.vendor, sig.rate, sig.entry, sig.residual]);
}

const inspectSourceNameClusters = defineAction({
  name: 'inspect_source_name_clusters',
  description:
    '检查一个来源的「名称形态簇」：把节点按识别出的语义签名(地区/路由/服务商/倍率/入口 + 残片首词)分组，返回每组数量与 2 条脱敏残片样本(分层、有界)。用 more_samples_for 可再取某一簇的额外样本(≤20 条)。用于判断上游命名规律、识别是否有规律可循。只读。',
  input: ClusterInput,
  risk: 'read',
  async run(ctx, input) {
    const source = await loadRawSource(ctx, input);
    const rules = source.renameOp?.recognitionRules;
    // round-1: ONE collision-checked node scope over the COMPLETE raw
    // snapshot BEFORE any cap/slice — a MAC collision anywhere (beyond
    // sample caps included) fails the response closed.
    const { scope: nodeScope } = buildNodeSnapshotScope(source.proxies);
    // TRUE per-cluster node counts tracked SEPARATELY from the stored
    // samples (pass-1 finding): a 50000-node cluster must report count
    // 50000 while only bounded samples are returned — the sample cap is
    // never the true total.
    const clusterCounts = new Map<string, number>();
    const clusters = new Map<string, Array<{ name: string; identity: string }>>();
    const occurrences = new Map<string, number>();
    for (const p of source.proxies) {
      const name = typeof p.name === 'string' ? p.name : '';
      if (name === '') continue;
      const sig = clusterSignatureOf(name, rules);
      const key = clusterGroupKey(sig);
      clusterCounts.set(key, (clusterCounts.get(key) ?? 0) + 1);
      const list = clusters.get(key) ?? [];
      if (list.length < 200) {
        const { identity } = nodeIdentityOf(p, occurrences);
        list.push({ name, identity }); // bounded sample store
      }
      clusters.set(key, list);
    }
    const ordered = [...clusters.entries()].sort(
      (a, b) => (clusterCounts.get(b[0]) ?? 0) - (clusterCounts.get(a[0]) ?? 0),
    );
    const capped = capList(ordered, MAX_CLUSTERS);
    const visible = capped.items;
    const extraIndex = input.more_samples_for;
    const data = visible.map(([key, entries], i) => {
      const count = clusterCounts.get(key) ?? 0;
      const extra = extraIndex === i ? entries.slice(2, 22) : [];
      // round-1: samples carry the OPAQUE node handle (projected through the
      // complete-domain scope) PLUS the bounded sanitized ORIGINAL display
      // name — useful recognition content, credential-free.
      const project = (e: { name: string; identity: string }) => ({
        handle: nodeScope.project(e.identity),
        name: sanitizeDisplayText(e.name),
      });
      // STRUCTURED signature (pass-4 finding): every field is projected
      // individually — sanitized display text (rule-authored values are
      // authorized when safe) — BEFORE any serialization; no join/split of
      // raw fields ever happens, so delimiter/metacharacter values cannot
      // change boundaries or leak residue. The residual token is dropped.
      const raw = JSON.parse(key) as [
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
      ];
      const projectField = (field: string, value: string | null): string | null => {
        void field;
        return value === null ? null : sanitizeDisplayText(value, 24);
      };
      const signature = {
        region: projectField('region', raw[0]),
        route: projectField('route', raw[1]),
        vendor: projectField('vendor', raw[2]),
        rate: raw[3],
        entry: projectField('entry', raw[4]),
      };
      return {
        index: i,
        count,
        signature,
        samples: entries.slice(0, 2).map(project),
        truncatedSamples: count > 2,
        ...(extra.length > 0
          ? { extraSamples: extra.map(project), truncatedExtraSamples: count > 2 + extra.length }
          : {}),
      };
    });
    return {
      kind: 'name-clusters',
      data: {
        source: input.ref,
        totalClusters: capped.total,
        truncatedClusters: capped.truncated,
        clusters: data,
      },
    };
  },
});

/* ─── inspect_node_parse ───────────────────────────────────────────── */

const NodeParseInput = z.object({
  ...SourceRef.shape,
  node_handle: NODE_HANDLE_SCHEMA.describe('不透明节点句柄(来自其它命名工具的样本/碰撞列表)'),
});

const inspectNodeParse = defineAction({
  name: 'inspect_node_parse',
  description:
    '查看某一个不透明节点的类型化解析：给出节点句柄(nd-开头，来自 inspect_naming_collisions / 预览结果)，返回该节点的识别事实(地区/路由/入口/服务商/倍率/协议)与脱敏残片。每次一个节点，有界；用于判断某个具体名字为什么识别成这样。只读。',
  input: NodeParseInput,
  risk: 'read',
  async run(ctx, input) {
    const source = await loadRawSource(ctx, input);
    // round-1: ONE collision-checked node scope over the COMPLETE raw
    // snapshot; resolution goes through the index (a MAC collision anywhere
    // fails closed, never a first-match pick, never a capped subset).
    const { scope: nodeScope } = buildNodeSnapshotScope(source.proxies);
    const identity = nodeScope.resolve(input.node_handle);
    if (identity === null) {
      throw ProblemDetailsError.badRequest(STALE_NODE_HANDLE_ERROR);
    }
    const occurrences = new Map<string, number>();
    let target: ClashProxy | undefined;
    let targetHandle: string | undefined;
    for (const p of source.proxies) {
      const name = typeof p.name === 'string' ? p.name : '';
      if (name === '') continue;
      const { identity: id } = nodeIdentityOf(p, occurrences);
      if (id === identity) {
        target = p;
        targetHandle = input.node_handle;
      }
    }
    if (!target || !targetHandle) {
      throw ProblemDetailsError.badRequest(STALE_NODE_HANDLE_ERROR);
    }
    const name = target.name as string;
    const recognized = recognizeName(name, source.renameOp?.recognitionRules);
    // Rule-authored values (fields a saved rule targets) project as keyed
    // rule tokens — never ordinary text (pass-3 finding); table-derived
    // canonical aggregates stay.
    const factValue = (_field: string, value: string | null): string | null => {
      if (value === null) return null;
      return sanitizeDisplayText(value, 24);
    };
    return {
      kind: 'node-parse',
      data: {
        node_handle: targetHandle,
        facts: {
          // Every value is structurally projected — a recognition-RULE value
          // (region included) could carry credential-shaped text and must
          // never re-enter the loop raw (C10).
          region: factValue('region', recognized.region),
          regionConfidence: recognized.confidence.region ?? null,
          rate: recognized.rate,
          rateConfidence: recognized.confidence.rate ?? null,
          route: factValue('route', recognized.route),
          routeConfidence: recognized.confidence.route ?? null,
          entry: factValue('entry', recognized.entry),
          entryConfidence: recognized.confidence.entry ?? null,
          vendor: factValue('vendor', recognized.vendor),
          vendorConfidence: recognized.confidence.vendor ?? null,
          protocol:
            typeof target.type === 'string' && target.type !== ''
              ? canonicalProxyType(target.type)
              : null,
        },
        // residual fragments are raw name-derived text — opaque tokens only
        fragment: recognized.base === '' ? null : sanitizeDisplayText(recognized.base, 24),
        ambiguous: recognized.regionSignals > 1 || recognized.routeSignals > 1 ? true : undefined,
      },
    };
  },
});

/* ─── preview_naming_recognition ───────────────────────────────────── */

/** The complete UNSAVED candidate: template + every policy field. */
const NamingCandidateSchema = z.object({
  ...SourceRef.shape,
  template: TemplateSchema,
  tw2cn: z.boolean().optional(),
  sourceAliases: ExternalSourceAliasesSchema.default({}),
  recognitionRules: RecognitionRulesSchema,
});

const RecognitionInput = NamingCandidateSchema.extend({
  // PRESENCE-SENSITIVE alias: NO default — an omitted `rules` stays
  // undefined so an explicitly supplied recognitionRules candidate wins.
  // (A defaulted [] here would silently shadow recognitionRules, which the
  // Delivery observed as "recognitionRules nonempty, rules empty, selected
  // empty".)
  rules: z
    .array(RecognitionRuleSchema)
    .max(32)
    .optional()
    .describe('候选识别规则别名(与 recognitionRules 同义，兼容旧字段名)。'),
});

const previewNamingRecognition = defineAction({
  name: 'preview_naming_recognition',
  description:
    '试算一个完整候选(模板 + tw2cn + 来源别名 + 识别规则)作用到该来源全部节点上的效果：每条规则命中多少节点、产生哪些事实值(有界)，以及候选方案的投影(重名消歧/真去重/改动数)——与其它预览同用候选模板/规则的序号语义。用于修正识别错误前先验证，不保存。',
  input: RecognitionInput,
  risk: 'read',
  async run(ctx, input) {
    const source = await loadRawSource(ctx, input);
    const rules = input.rules ?? input.recognitionRules;
    // The CANDIDATE drives everything (never the saved plan when the
    // candidate supplies the field): ordinal semantics follow the candidate
    // template + rules, and the awaited result feeds the projected block.
    const template = input.template;
    const ordinals = await readOnlyOrdinals(source, template, rules);
    // pass-8 blocker 1: the model's src- handles translate through the
    // entity's AUTHORITATIVE key set here — invented/ambiguous/duplicate
    // keys fail the same bounded error before any projection is emitted.
    const sourceAliases = resolveSourceAliasKeys(input.sourceAliases, source.keys);
    const projected = applyRenameTemplate(
      source.proxies,
      {
        template,
        tw2cn: input.tw2cn,
        sourceAliases,
        recognitionRules: rules,
      },
      sourceOf,
      ordinals,
    );
    const perRule = rules.map((rule) => {
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'i');
      } catch {
        return { pattern: safeText(rule.pattern), field: rule.field, matches: 0, values: [] };
      }
      const values = new Map<string, number>();
      let matches = 0;
      for (const p of source.proxies) {
        const name = typeof p.name === 'string' ? p.name : '';
        if (name === '' || !re.test(name)) continue;
        matches += 1;
        const recognized = recognizeName(name, rules);
        const value =
          rule.field === 'region'
            ? (recognized.region ?? '')
            : rule.field === 'route'
              ? (recognized.route ?? '')
              : rule.field === 'entry'
                ? (recognized.entry ?? '')
                : (recognized.vendor ?? '');
        if (value !== '') values.set(value, (values.get(value) ?? 0) + 1);
      }
      // Rule-authored text (pattern, configured value and the fact values
      // the rule's field produces) projects as KEYED tokens — never ordinary
      // text (pass-3 finding). Index/field/match totals and truncation stay.
      const valuesAll = [...values.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([v, n]) => ({ value: sanitizeDisplayText(v, 24) ?? '(已脱敏)', count: n }));
      const valuesCapped = capList(valuesAll, 4);
      return {
        pattern: sanitizeDisplayText(rule.pattern, 100) ?? '(已脱敏)',
        field: rule.field,
        value: sanitizeDisplayText(rule.value, 24) ?? '(已脱敏)',
        matches,
        values: valuesCapped.items,
        totalValues: valuesCapped.total,
        truncatedValues: valuesCapped.truncated,
      };
    });
    const reports = analyzeSourceFacts(source.proxies, { rules });
    const coverageCapped = capList(
      projectHealth(
        reports,
        buildNodeSnapshotScope(source.proxies).scope,
        ruleTargetedFields(rules),
      ).map((r) => ({
        source: r.source,
        fields: r.fields,
      })),
      MAX_SOURCES,
    );
    return {
      kind: 'recognition-preview',
      data: {
        source: input.ref,
        // the RAW DSL template is never serialized — only its structural
        // summary (pass-2 finding)
        templateSummary: summarizeTemplate(template),
        rules: perRule,
        coverage: coverageCapped.items,
        totalCoverageSources: coverageCapped.total,
        truncatedCoverageSources: coverageCapped.truncated,
        // The awaited candidate projection — the ordinal resolver was applied
        // here (no dropped promise), so numbering shown matches the other
        // candidate previews. The raw formatted-name strings never
        // serialize: counts carry the aggregate facts.
        projected: {
          nodeCount: source.proxies.length,
          changed: projected.changed,
          totalCollisions: projected.collisions.length,
          truncatedCollisions: projected.collisions.length > MAX_COLLISIONS,
          totalDeduped: projected.deduped.length,
          truncatedDeduped: projected.deduped.length > MAX_DEDUPED,
        },
      },
    };
  },
});

/* ─── inspect_naming_drift ─────────────────────────────────────────── */

const inspectNamingDrift = defineAction({
  name: 'inspect_naming_drift',
  description:
    '检查识别漂移：残片里出现了「疑似字段信号但没有命中」的模式(超界倍率、未知路由词、表外旗标等)——上游改名习惯漂移的信号。返回每个漂移字段的样本。只读。',
  input: SourceRef,
  risk: 'read',
  async run(ctx, input) {
    const source = await loadRawSource(ctx, input);
    const reports = analyzeSourceFacts(source.proxies, {
      rules: source.renameOp?.recognitionRules,
    });
    // round-2: ONE source scope over the COMPLETE report key set before any
    // cap — drift entries project their member-source handle through it.
    const reportSourceScope = buildSourceAliasScope(reports.map((r) => r.sourceKey));
    // 50000 sources × up-to-3 drift patterns must never return 150000 rows:
    // deterministic hard cap with the TRUE total + explicit truncation.
    const driftAll = reports.flatMap((report) =>
      report.drift.map((d) => ({
        source: reportSourceScope.project(report.sourceKey),
        field: d.field,
        count: d.count,
        samples: d.samples.map((sample) => sanitizeDisplayText(sample, 24) ?? '(已脱敏)'),
        samplesTruncated: d.samplesTruncated,
      })),
    );
    const driftCapped = capList(driftAll, MAX_DRIFT);
    return {
      kind: 'naming-drift',
      data: {
        source: input.ref,
        drift: driftCapped.items,
        totalDrift: driftCapped.total,
        truncatedDrift: driftCapped.truncated,
      },
    };
  },
});

/* ─── collisions / references ──────────────────────────────────────── */

/**
 * Complete UNSAVED candidate for inspection: template + every policy field.
 * Any omitted field falls back to the saved plan (or the recommended
 * template when nothing is saved) — but an EXPLICITLY supplied field always
 * wins, so the assistant can inspect a candidate before saving it (C6).
 */
const CollisionInput = z.object({
  ...SourceRef.shape,
  template: TemplateSchema.optional().describe('省略=用当前已保存模板(无则用推荐模板)'),
  tw2cn: z.boolean().optional().describe('候选简繁转换；省略=沿用已保存设置'),
  sourceAliases: ExternalSourceAliasesSchema.describe(
    '候选来源别名表（键必须是 src- 不透明句柄，Record<src-句柄, string>；普通来源名会被拒绝）；省略=沿用已保存设置',
  ),
  recognitionRules: z
    .array(RecognitionRuleSchema)
    .max(32)
    .optional()
    .describe('候选识别规则；省略=沿用已保存规则'),
});

const inspectNamingCollisions = defineAction({
  name: 'inspect_naming_collisions',
  description:
    '检查一个命名目标当前的名称冲突与引用影响：用当前(或给定)模板对真实节点试算——格式化重名(将用 来源+稳定序号 消歧)、同配置节点去重(按来源优先级)、以及按名引用的链式后端 / 策略组成员 / 规则 policy 会因改名而悬空的清单(链后端悬空会让配置加载失败)。只读。',
  input: CollisionInput,
  risk: 'read',
  async run(ctx, input) {
    const source = await loadRawSource(ctx, input);
    // The CANDIDATE (when supplied) drives semantics — saved fields only
    // when the candidate omits them.
    const template =
      input.template ?? source.renameOp?.template ?? defaultTemplateFor(source.aggregate);
    const recognitionRules = input.recognitionRules ?? source.renameOp?.recognitionRules;
    const config = {
      template,
      tw2cn: input.tw2cn ?? source.renameOp?.tw2cn,
      sourceAliases:
        resolveSourceAliasKeys(input.sourceAliases, source.keys) ??
        source.renameOp?.sourceAliases ??
        {},
      recognitionRules,
    };
    const ordinals = await readOnlyOrdinals(source, template, recognitionRules);
    const result = applyRenameTemplate(source.proxies, config, sourceOf, ordinals);

    const beforeNames = source.proxies.map((p) => (typeof p.name === 'string' ? p.name : ''));
    const afterNames = new Set(
      result.proxies.map((p) => (typeof p.name === 'string' ? p.name : '')),
    );
    const disappeared = [...new Set(beforeNames)].filter((n) => n && !afterNames.has(n));
    const orphaned = await findNodeReferences(ctx.profileId, disappeared);

    // round-2: ONE collision-checked node scope over the COMPLETE raw
    // snapshot shared by the collision/dedup projections — participant
    // handles come DIRECTLY from the executor's identity-bound diagnostics
    // (rawName + fingerprint + exact occurrence emitted at collision time)
    // and are projected through that scope, never freshly minted. An
    // identity outside the snapshot fails closed.
    const { scope: nodeScope } = buildNodeSnapshotScope(source.proxies);
    const exactHandle = (
      rawName: string | undefined,
      fp: string | null | undefined,
      occurrence: number | undefined,
    ): string | undefined => {
      if (rawName === undefined || !fp || occurrence === undefined) return undefined;
      return nodeScope.project(`${rawName}\x00${fp}\x00${occurrence}`);
    };
    const stepSourceScope = buildSourceAliasScope(
      result.deduped.flatMap((d) => (d.sourceKey !== undefined ? [d.sourceKey] : [])),
    );

    // Collision handles + resolved names from the executor's identity-bound
    // diagnostics (rawName + fingerprint + occurrence emitted at collision
    // time — never reconstructed from a display-name match).
    // Collision handles + resolved names from the executor's identity-bound
    // diagnostics: EVERY participant carries its own final resolved name +
    // handle (rawName + fingerprint + occurrence emitted at collision time —
    // never reconstructed from a display-name match).
    // OPAQUE projections (pass-2 finding): collision groups and participants
    // carry only opaque handles + counts — the formatted name strings and
    // resolved final names are raw node-name text and never serialize.
    const collisionBy = new Map<string, Array<{ handle?: string }>>();
    for (const entry of result.collisionNodes) {
      collisionBy.set(
        entry.name,
        entry.participants.map((p) => {
          const handle = exactHandle(p.rawName, p.fingerprint, p.occurrence);
          return handle ? { handle } : {};
        }),
      );
    }

    // Deduped handles: the executor emits the exact raw name + occurrence
    // for BOTH kept and dropped (a duplicate with a different raw name than
    // its twin resolves to ITS OWN handle, not the first occurrence's).
    const dedupedAll = result.deduped.map((d) => ({
      keptHandle: exactHandle(d.keptRawName, d.keptFingerprint, d.keptOccurrence),
      droppedHandle: exactHandle(d.droppedRawName, d.droppedFingerprint, d.droppedOccurrence),
      ...(d.sourceKey !== undefined ? { sourceKey: stepSourceScope.project(d.sourceKey) } : {}),
    }));
    const dedupedCapped = capList(dedupedAll, MAX_DEDUPED);
    const collisionsAll = result.collisionNodes.map((entry) => {
      const participants = capList(collisionBy.get(entry.name) ?? [], MAX_PARTICIPANTS);
      return {
        participants: participants.items,
        totalParticipants: participants.total,
        truncatedParticipants: participants.truncated,
      };
    });
    const collisionsCapped = capList(collisionsAll, MAX_COLLISIONS);
    const orphanedCapped = capList(
      orphaned.map((ref) => ({
        // referenced config names are raw text — opaque tokens only
        node: safeText(ref.node, '(已脱敏)'),
        kind: ref.kind,
        via: safeText(ref.via, '(已脱敏)'),
      })),
      MAX_ORPHANED,
    );

    return {
      kind: 'naming-collisions',
      data: {
        source: input.ref,
        templateSummary: summarizeTemplate(template),
        nodeCount: source.proxies.length,
        changed: result.changed,
        // ONE entry per colliding formatted name (the executor groups every
        // participant); the legacy per-displaced-node `collisions` array is
        // not re-expanded into duplicate groups. Every list is capped with
        // deterministic totals + truncation flags (pass-3 finding).
        collisions: collisionsCapped.items,
        totalCollisions: collisionsCapped.total,
        truncatedCollisions: collisionsCapped.truncated,
        deduped: dedupedCapped.items,
        totalDeduped: dedupedCapped.total,
        truncatedDeduped: dedupedCapped.truncated,
        orphanedReferences: orphanedCapped.items,
        totalOrphaned: orphanedCapped.total,
        truncatedOrphaned: orphanedCapped.truncated,
      },
    };
  },
});

/* ─── preview_naming_target (round-trip candidate) ─────────────────── */

const previewNamingTarget = defineAction({
  name: 'preview_naming_target',
  description:
    '试算一个完整的命名方案(模板 + tw2cn + 来源别名 + 识别规则)作用到真实节点的效果：前/后名称样本(脱敏、有界)、重名消歧、真去重、占位符覆盖率、引用影响。读工具可反复迭代；最终方案原样传给 save_naming_plan 一次确认落地。只读、无渲染副作用。',
  input: NamingCandidateSchema,
  risk: 'read',
  async run(ctx, input) {
    const source = await loadRawSource(ctx, input);
    const config = {
      template: input.template,
      tw2cn: input.tw2cn,
      sourceAliases: resolveSourceAliasKeys(input.sourceAliases, source.keys),
      recognitionRules: input.recognitionRules,
    };
    // Candidate template + candidate rules drive ordinal semantics.
    const ordinals = await readOnlyOrdinals(source, input.template, input.recognitionRules);
    const result = applyRenameTemplate(source.proxies, config, sourceOf, ordinals);
    const beforeNames = source.proxies.map((p) => (typeof p.name === 'string' ? p.name : ''));
    const afterNames = new Set(
      result.proxies.map((p) => (typeof p.name === 'string' ? p.name : '')),
    );
    const disappeared = [...new Set(beforeNames)].filter((n) => n && !afterNames.has(n));
    const orphaned = await findNodeReferences(ctx.profileId, disappeared);

    const reports = analyzeSourceFacts(source.proxies, { rules: input.recognitionRules });
    const coverageAll = projectHealth(
      reports,
      buildNodeSnapshotScope(source.proxies).scope,
      ruleTargetedFields(input.recognitionRules),
    ).map((r) => ({
      source: r.source,
      fields: r.fields,
    }));
    const coverageCapped = capList(coverageAll, MAX_SOURCES);
    const usedFields = reports.flatMap((r) => r.fields);
    // round-1: Opaque handles for the raw + final lists — discovery for
    // inspect_node_parse. ONE collision-checked scope over EACH COMPLETE
    // list BEFORE the cap; samples carry the bounded sanitized ORIGINAL
    // display names too (useful recognition content). TRUE totals: the
    // sample cap is never reported as the node count (pass-1 finding).
    const { scope: beforeScope, identities: beforeIdentities } = buildNodeSnapshotScope(
      source.proxies,
    );
    // project the COMPLETE list through the scope, THEN cap — truthful
    // totals + truncation describe the full domain (pass-1 finding)
    const beforeCapped = capList(
      beforeIdentities.map((identity, i) => ({
        handle: beforeScope.project(identity),
        name: sanitizeDisplayText(
          typeof source.proxies[i].name === 'string' ? (source.proxies[i].name as string) : '',
        ),
      })),
      3,
    );
    const beforeEntries = beforeCapped.items;
    // FRESH occurrence base for the after list: the parse action scans the
    // RAW list with its own fresh map, and exact duplicates never survive
    // the managed stage — so surviving nodes always carry occurrence 0 and a
    // handle emitted here round-trips to the same raw node.
    const { scope: afterScope, identities: afterIdentities } = buildNodeSnapshotScope(
      result.proxies,
    );
    const afterCapped = capList(
      afterIdentities.map((identity, i) => ({
        handle: afterScope.project(identity),
        name: sanitizeDisplayText(
          typeof result.proxies[i].name === 'string' ? (result.proxies[i].name as string) : '',
        ),
      })),
      8,
    );
    const afterEntries = afterCapped.items;

    return {
      kind: 'naming-target-preview',
      data: {
        source: input.ref,
        // the RAW DSL template is never serialized — only its structural
        // summary (pass-2 finding)
        templateSummary: summarizeTemplate(input.template),
        nodeCount: source.proxies.length,
        changed: result.changed,
        totalCollisions: result.collisions.length,
        truncatedCollisions: result.collisions.length > MAX_COLLISIONS,
        totalDeduped: result.deduped.length,
        truncatedDeduped: result.deduped.length > MAX_DEDUPED,
        beforeSamples: beforeEntries,
        totalBeforeNodes: beforeCapped.total,
        truncatedBeforeSamples: beforeCapped.truncated,
        afterSamples: afterEntries,
        totalAfterNodes: afterCapped.total,
        truncatedAfterSamples: afterCapped.truncated,
        coverage: coverageCapped.items,
        totalCoverageSources: coverageCapped.total,
        truncatedCoverageSources: coverageCapped.truncated,
        unavailableFields: [
          ...new Set(usedFields.filter((f) => f.present === 0).map((f) => f.field)),
        ],
        orphanedReferences: capList(
          orphaned.map((ref) => ({
            node: safeText(ref.node, '(已脱敏)'),
            kind: ref.kind,
            via: safeText(ref.via, '(已脱敏)'),
          })),
          MAX_ORPHANED,
        ).items,
        totalOrphaned: orphaned.length,
        truncatedOrphaned: orphaned.length > MAX_ORPHANED,
      },
    };
  },
});

/* ─── save_naming_plan (confirmation-gated write) ──────────────────── */

const SavePlanInput = z.object({
  ...NamingCandidateSchema.shape,
  position: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('新增时插入位置下标；省略=追加到管线末尾。已有模板时原地替换，忽略该字段。'),
});

const sourceLabel = (t: 'subscription' | 'collection'): string =>
  t === 'subscription' ? '订阅源' : '聚合订阅';

const saveNamingPlan = defineWriteAction({
  name: 'save_naming_plan',
  description:
    '把完整的命名方案(模板 + tw2cn + sourceAliases + recognitionRules)作为「名称统一」算子落地：已有模板则原地替换，没有则新增(可指定 position)。需用户确认；保存前会对每个受影响配置文件用同一候选做完整预检并 CAS 提交(与工作台保存同一闸门)。先用 preview_naming_target 验证同一份方案。',
  input: SavePlanInput,
  risk: 'write',
  summary: (i) => `${sourceLabel(i.source_type)}应用命名模板：${safeText(i.template).slice(0, 40)}`,
  async preview(ctx, input) {
    // Confirmation binding: the card records the configVersion AND the
    // membership bracket (profile source binding + caller-visible set) at
    // preview-time; execute fails closed when either is absent or stale
    // (pass-7 blocker 4).
    const configVersion = await getConfigVersion();
    const membership = await captureNamingMembership(await requireCallerProfile(ctx.profileId));

    // The candidate comes from the SAME shared builder apply uses: external
    // src- handles are resolved to stable source keys FIRST (invented/
    // ambiguous handles fail the bounded alias error), then one complete
    // plan (explicit fields win, absent fields keep the current row's
    // policy) is built over the aligned raw snapshot. No reserved literal
    // id, no second candidate maker — preview and apply are identical.
    const build = (
      entity: { operators?: unknown[] },
      label: string,
      keys: string[],
    ): WritePreview => {
      const stableAliases = resolveSourceAliasKeys(input.sourceAliases, keys);
      const managedOp = buildOperatorSnapshot(entity).managed?.decoded;
      const candidate = namingCandidateForEntity(
        entity,
        completeNamingPlan(
          {
            template: input.template,
            tw2cn: input.tw2cn,
            sourceAliases: stableAliases,
            recognitionRules: input.recognitionRules,
          },
          priorPolicyOf(managedOp),
        ),
      );
      // NOTE: no current-write list assertion here — the candidate may
      // legitimately preserve aligned parked/legacy raw rows that the
      // generic write schema rejects; apply validates the storage list and
      // the new managed projection identically (namingApplyService).
      const mode = candidate.mode === 'added' ? 'add rename-template' : 'replace rename-template';
      return {
        diff: {
          op: 'update',
          path: `${label}.operators`,
          mode,
          // the collision-free id BOTH preview and apply will land on —
          // observable parity for the confirmation card and tests
          managedRowId: candidate.id,
          template: safeText(input.template).slice(0, 512),
          recognitionRuleCount: input.recognitionRules.length,
          aliasCount: Object.keys(input.sourceAliases).length,
          operatorCount: candidate.operators.length,
          concurrency: { expectedVersion: configVersion },
        },
        confirmation: { configVersion, membership },
      };
    };

    const { type, id } = await resolveTargetByRef(ctx, input.source_type, input.ref);
    if (type === 'subscription') {
      const sub = await getSubscription(id);
      if (!sub) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
      return build(
        sub,
        `subscriptions[${safeText(sub.display_name?.trim() || sub.name, '(未命名)').slice(0, 48)}]`,
        [sub.name],
      );
    }
    const col = await getCollection(id);
    if (!col) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    const keys = enabledCollectionMemberSubs(col, await listSubscriptions()).map((m) => m.name);
    return build(col, `collections[${safeText(col.name, '(未命名)').slice(0, 48)}]`, keys);
  },
  async execute(ctx, input) {
    // Confirmation-time configVersion guard: the card's approved version is
    // the ONLY bracket the mutation may run under. Absent or stale → fail
    // closed BEFORE any preflight/write (staleness between card creation and
    // the user clicking confirm is exactly the race this catches).
    const expectedVersion = ctx.confirmation?.configVersion;
    const expectedMembership = ctx.confirmation?.membership;
    if (expectedVersion === undefined) {
      throw ProblemDetailsError.preconditionFailed('确认记录缺少配置版本，请重新发起确认。');
    }
    if (expectedMembership === undefined) {
      throw ProblemDetailsError.preconditionFailed('确认记录缺少来源绑定快照，请重新发起确认。');
    }
    // The SAME audited path as the workspace UI apply: planning bracket
    // bound to the approved version, every consuming profile preflighted
    // against the exact candidate, and config + config:version +
    // naming-history created in ONE atomic CAS. Rollback afterwards works
    // exactly like a UI apply (the prior state is persisted as the target).
    // The durable audit event is part of the FAIL-CLOSED transition: it is
    // The durable audit event is built by the SHARED service builder
    // (sanitized + bounded + AuditEventSchema-validated) and committed IN the
    // same atomic Lua CAS as entity + history + version — fail-closed: an
    // audit key/payload failure leaves entity/history/version/audit
    // untouched, and each success creates exactly one event.
    const { id } = await resolveTargetByRef(ctx, input.source_type, input.ref);
    const result = await applyNamingPlan(
      input.source_type,
      id,
      {
        template: input.template,
        tw2cn: input.tw2cn,
        sourceAliases:
          Object.keys(input.sourceAliases).length > 0 ? input.sourceAliases : undefined,
        recognitionRules: input.recognitionRules,
      },
      {
        position: input.position,
        expectedVersion,
        expectedMembership,
        audit: { actor: ctx.actor, profileId: ctx.profileId },
      },
    );
    return {
      kind: 'write-result',
      data: {
        op: 'update',
        // Keep the model-facing receipt useful without echoing the target
        // label: when display_name is absent the service label can be the
        // internal stable slug. The authorized opaque ref remains in result.
        summary: '已应用命名模板',
        // round-2: echo the ALREADY-AUTHORIZED input ref — never mint a
        // fresh one. round-3: the enriched naming-plan event is INTERNAL
        // (moved under `result`) — the UI events array stays exact
        // {id, op, undoable?} undo events only; the durable audit stays
        // internal too.
        result: {
          ref: input.ref,
          mode: result.mode,
          events: [
            {
              type: 'naming-plan-saved',
              sourceType: input.source_type,
              ref: input.ref,
              planningVersion: result.planningVersion,
              confirmedVersion: result.confirmedVersion,
              history: result.history,
              mode: result.mode,
            },
          ],
        },
        events: [],
      },
    };
  },
});

export const NAMING_READ_ACTIONS = [
  listNamingTargets,
  inspectNamingFields,
  inspectSourceNameClusters,
  inspectNamingCollisions,
  inspectNodeParse,
  previewNamingRecognition,
  inspectNamingDrift,
  previewNamingTarget,
];
export const NAMING_WRITE_ACTIONS = [saveNamingPlan];
