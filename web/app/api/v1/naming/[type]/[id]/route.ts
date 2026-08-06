/**
 * /api/v1/naming/[type]/[id] — the 智能命名 workspace contract.
 *
 * GET  — target-centric view for ONE subscription source or collection:
 *   - entity + managed state (current template / aliases / rules), the
 *     deterministic recommended template when nothing is managed yet;
 *   - the PERSISTED prior plan (rollback target — a real prior plan, not a
 *     draft reset);
 *   - naming health: per-source placeholder field matrix (coverage counts +
 *     percentages, per-value confidence + provenance, sanitized samples,
 *     bounded per-node typed facts) plus unavailable / partial / ambiguous /
 *     drift diagnostics (lib/proxies/namingHealth);
 *   - collision + true-dedup diagnostics from running the CURRENT managed
 *     template (or the recommended one) over the real nodes, with the same
 *     deterministic compiler render/export/preview use;
 *   - consuming profiles (shared-source preflight semantics) and the
 *     name references a rename would orphan.
 *
 * POST — the ONLY apply path for the workspace:
 *   - `{ apply: { template, tw2cn?, sourceAliases?, recognitionRules? } }`
 *     applies a new plan: the previous active plan (every policy field) is
 *     persisted as the rollback target, the rename-template op is replaced
 *     IN PLACE (id + untouched policy fields preserved), and the operators
 *     PATCH runs through the shared save gate (CAS + all-consumer preflight).
 *   - `{ rollback: true }` PATCHes the persisted prior plan back and clears
 *     the history entry.
 *
 * No persisted ordinal assignments are published by this endpoint (the
 * ordinal snapshot is read-only); every write goes through the standard
 * operator-save gate.
 */

import { withProblemDetails } from '@/lib/http/handler';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import {
  projectAliasKeysToHandles,
  resolveSourceAliasKeys,
} from '@/lib/services/sourceAliasResolver';
import {
  namingCandidateForEntity,
  previewNamingCollection,
  previewNamingSubscription,
} from '@/lib/services/namingPreviewService';
import { completeNamingPlan, priorPolicyOf } from '@/lib/services/namingManagedCandidate';
import { buildOperatorSnapshot } from '@/lib/repos/rawOperators';
import { ExternalSourceAliasesSchema } from '@/schemas/externalAliases';
import {
  buildProfileScope,
  buildSourceAliasScope,
  buildTargetRefScope,
} from '@/lib/proxies/handleScopes';
import { buildNodeSnapshotScope } from '@/lib/ai/namingContextProjection';
import {
  GLOBAL_NAMING_SCOPE_ID,
  NAMING_SCOPE_ERROR,
  globalNamingTargets,
  requireGlobalNamingTarget,
} from '@/lib/services/namingTargetScope';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  applyRenameTemplate,
  defaultTemplateFor,
  validateTemplate,
  withRawIdentity,
} from '@/lib/proxies/naming';
import { redactSensitiveText } from '@/lib/proxies/namingSanitize';
import { analyzeSourceFacts } from '@/lib/proxies/namingHealth';
import { sourceOf } from '@/lib/proxies/provenance';
import { resolveOrdinalsFor } from '@/lib/services/nodeOrdinalService';
import { mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import { getCollection } from '@/lib/services/collectionService';
import { getSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { applyNamingPlan, rollbackNamingPlan } from '@/lib/services/namingApplyService';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { getNamingHistory, type NamingHistoryPlan } from '@/lib/repos/namingHistoryRepo';
import {
  consumingProfilesOfCollection,
  consumingProfilesOfSubscription,
} from '@/lib/services/nodePipelineSaveGate';
import { orphanedReferenceIssues, safeIssueText } from '@/lib/services/pipelinePreview';
import { resolveActor } from '@/lib/services/rulesService';
import {
  isActiveCurrentRenameTemplateOperator,
  isCurrentRenameTemplateOperator,
  RecognitionRuleSchema,
  type Operator,
  type StoredOperator,
} from '@/schemas';
import { z } from '@/lib/openapi/zod';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/naming/[type]/[id]'>;

const Params = z.object({
  type: z.enum(['subscription', 'collection']),
  id: z.uuid(),
});

const PlanBody = z
  .object({
    template: z
      .string()
      .min(1, '模板不能为空')
      .max(512, '模板过长')
      .superRefine((template, ctx) => {
        const validation = validateTemplate(template);
        if (!validation.ok) {
          ctx.addIssue({ code: 'custom', message: validation.message });
        }
      }),
    tw2cn: z.boolean().optional(),
    // pass-8 blocker 1: the UI round-trips PROJECTED src- handles — plain
    // stable keys fail at parse with the bounded order-independent error.
    sourceAliases: ExternalSourceAliasesSchema,
    recognitionRules: z.array(RecognitionRuleSchema).max(32, '识别规则最多 32 条').optional(),
  })
  .strict();

const ExpectedVersion = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER, '配置版本超出安全范围');

const ApplyBody = z.object({ apply: PlanBody, expectedVersion: ExpectedVersion }).strict();

/**
 * Read-only workspace preview variant: build the SAME managed candidate the
 * apply path would produce (shared builder) and dry-run the candidate
 * pipeline with the shared zero-write preview functions — no save, no
 * cache write, no audit.
 */
const PreviewBody = z.object({ preview: PlanBody }).strict();

const RollbackBody = z
  .object({
    rollback: z.literal(true),
    expectedVersion: ExpectedVersion,
  })
  .strict();

const PostBody = z.union([ApplyBody, PreviewBody, RollbackBody]);

/** Project a PERSISTED history plan for the workspace response — explicit
 * fields only (template/tw2cn/sourceAliases/disabled). rawOp, opId, position
 * and recognition-rule patterns are internal storage data that must never
 * leave storage (finding 5). */
function projectHistoryPlan(
  prior: NamingHistoryPlan | null,
  sourceKeys: string[],
): {
  present: boolean;
  template?: string;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  disabled?: boolean;
} {
  if (!prior) return { present: false };
  return {
    present: true,
    // display-only surface: dirty template content (URLs/tokens/credentials)
    // is redacted + bounded before it can leave storage (finding 7). The
    // EDITABLE managed template stays raw — the editor round-trips it.
    ...(prior.template !== undefined
      ? { template: redactSensitiveText(prior.template).slice(0, 512) }
      : {}),
    ...(prior.tw2cn !== undefined ? { tw2cn: prior.tw2cn } : {}),
    ...(prior.sourceAliases !== undefined
      ? {
          // pass-6 blocker 2: alias KEYS project to opaque src-* handles;
          // values stay redacted + bounded
          sourceAliases: projectAliasKeysToHandles(
            Object.fromEntries(
              Object.entries(prior.sourceAliases).map(([k, v]) => [
                k,
                redactSensitiveText(v).slice(0, 40),
              ]),
            ),
            sourceKeys,
          ),
        }
      : {}),
    ...(prior.disabled !== undefined ? { disabled: prior.disabled } : {}),
  };
}

/** Active rename-template op, when one exists. */
function activeRenameOp(
  operators: StoredOperator[] | undefined,
): (Operator & { kind: 'rename-template' }) | undefined {
  return (operators ?? []).find(isActiveCurrentRenameTemplateOperator);
}

/** Project a rename op to the workspace managed/prior plan shape. Alias
 * KEYS are projected to opaque src-* handles (pass-6 blocker 2) — stable
 * source keys never leave storage through this surface. */
function planOf(
  op:
    | {
        kind: string;
        template?: string;
        tw2cn?: boolean;
        sourceAliases?: Record<string, string>;
        recognitionRules?: unknown[];
        disabled?: boolean;
      }
    | undefined,
  projectAliases: (a: Record<string, string>) => Record<string, string>,
): {
  present: boolean;
  template?: string;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: Operator['kind'] extends never ? never : unknown[];
  disabled?: boolean;
} {
  if (!op) return { present: false };
  return {
    present: true,
    template: op.template,
    tw2cn: op.tw2cn === true,
    sourceAliases: projectAliases(op.sourceAliases ?? {}),
    recognitionRules: op.recognitionRules ?? [],
    // activation state: a persisted (aligned) rename-template row that is
    // disabled is still managed history — the workspace shows its stored
    // policy and can apply (re-enable) it without any other edit
    disabled: op.disabled === true,
  };
}

interface WorkspacePayload {
  /** Version of the complete read snapshot. Apply/rollback must echo it so a
   * lost success response cannot be replayed as a second write. */
  configVersion: number;
  entity: { type: 'subscription' | 'collection'; ref: string; label: string };
  aggregate: boolean;
  managed: ReturnType<typeof planOf>;
  priorPlan: ReturnType<typeof planOf>;
  recommended: string;
  health: ReturnType<typeof analyzeSourceFacts>;
  diagnostics: {
    nodeCount: number;
    changed: number;
    collisions: string[];
    deduped: Array<{ kept: string; dropped: string; sourceKey?: string }>;
    beforeNames: string[];
    afterNames: string[];
    truncated: boolean;
  };
  references: {
    consumingProfiles: Array<{ id: string; name: string }>;
    orphaned: unknown[];
  };
}

/** Close the read-only target → snapshot race with the same config-version
 * generation that protects writes. Entity deletion or any intervening config
 * change fails closed instead of returning a stale workspace payload. */
async function assertReadScopeSnapshot(
  type: 'subscription' | 'collection',
  id: string,
  expectedVersion: number,
): Promise<void> {
  const beforeAuth = await getConfigVersion();
  if (beforeAuth !== expectedVersion) {
    throw ProblemDetailsError.preconditionFailed('配置已发生变化，请重新加载命名工作台。');
  }
  await requireGlobalNamingTarget(type, id);
  const afterAuth = await getConfigVersion();
  if (afterAuth !== expectedVersion) {
    throw ProblemDetailsError.preconditionFailed('配置已发生变化，请重新加载命名工作台。');
  }
}

/** Load the source + compute the full workspace payload (shared by GET/POST). */
async function loadWorkspace(
  type: 'subscription' | 'collection',
  id: string,
): Promise<WorkspacePayload> {
  // Bind the entire potentially slow workspace read (including upstream
  // diagnostics) to one config generation. If anything moves while it is
  // assembled, fail closed and let the client reload instead of returning a
  // stale entity with a fresh version token.
  const workspaceVersion = await getConfigVersion();
  const finalize = async (
    payload: Omit<WorkspacePayload, 'configVersion'>,
  ): Promise<WorkspacePayload> => {
    await assertReadScopeSnapshot(type, id, workspaceVersion);
    return { configVersion: workspaceVersion, ...payload };
  };
  const [profiles] = await Promise.all([listProfiles()]);
  if (type === 'subscription') {
    const sub = await getSubscription(id);
    if (!sub) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    // activation authority: the ALIGNED snapshot's managed row — a disabled
    // current-valid rename-template is still managed (state 'disabled')
    const managedDecoded = buildOperatorSnapshot(sub).managed?.decoded;
    const managedOp =
      managedDecoded && isCurrentRenameTemplateOperator(managedDecoded)
        ? managedDecoded
        : undefined;
    const renameOp = activeRenameOp(sub.operators);
    const recommended = defaultTemplateFor(false);
    // A disabled managed row is still the editable workspace draft. When no
    // row exists, diagnostics preview the deterministic recommendation. The
    // ordinal resolver and the renderer must consume this exact same policy.
    const previewOp = managedOp ?? renameOp;
    const effectiveTemplate = previewOp?.template ?? recommended;
    const { proxies } = await resolveSubscriptionProxiesRaw(sub, { writeCache: false });
    const identity = { key: sub.name, label: sub.display_name?.trim() || sub.name };
    const withProvenance = proxies.map((p) => withRawIdentity(p, identity));
    // round-1: the health report is INTERNAL analysis — external projections
    // go through ONE collision-checked node scope over the COMPLETE snapshot
    // and ONE source scope over the complete key set (handle minting lives in
    // handleScopes/namingContextProjection, never in the analysis).
    const reports = analyzeSourceFacts(withProvenance, { rules: previewOp?.recognitionRules });
    const { scope: nodeScope } = buildNodeSnapshotScope(withProvenance);
    const sourceScope = buildSourceAliasScope(reports.map((r) => r.sourceKey));
    const health = reports.map((report) => ({
      ...report,
      sourceKey: sourceScope.project(report.sourceKey),
      nodeFacts: report.nodeFacts.map((f) => ({ ...f, node: nodeScope.project(f.node) })),
    }));
    const ordinals = await resolveOrdinalsFor(withProvenance, sourceOf, {
      persist: false,
      template: effectiveTemplate,
      recognitionRules: previewOp?.recognitionRules ?? [],
    });
    const result = applyRenameTemplate(
      withProvenance,
      {
        template: effectiveTemplate,
        tw2cn: previewOp?.tw2cn,
        sourceAliases: previewOp?.sourceAliases ?? {},
        recognitionRules: previewOp?.recognitionRules ?? [],
      },
      sourceOf,
      ordinals,
    );
    const before = withProvenance.map((p) => p.name as string);
    const after = result.proxies.map((p) => p.name as string);
    const [collections, allSubs] = await Promise.all([
      import('@/lib/repos/collectionsRepo').then((m) => m.listCollections()),
      listSubscriptions(),
    ]);
    const consuming = consumingProfilesOfSubscription(sub, collections, allSubs, profiles);
    const prior = await getNamingHistory('subscription', id);
    const sourceKeys = [sub.name];
    const projectAliases = (a: Record<string, string>): Record<string, string> =>
      projectAliasKeysToHandles(a, sourceKeys) ?? {};
    // round-2: the entity ref is projected through ONE target scope over the
    // COMPLETE caller-visible union (never a fresh single mint)
    const visible = await globalNamingTargets();
    const targetScope = buildTargetRefScope(GLOBAL_NAMING_SCOPE_ID, visible);
    return finalize({
      entity: {
        type,
        ref: targetScope.project(`${type}:${id}`),
        label: sub.display_name?.trim() || sub.name,
      },
      aggregate: false,
      managed: planOf(managedOp, projectAliases),
      priorPlan: projectHistoryPlan(prior, sourceKeys),
      recommended,
      health,
      diagnostics: {
        nodeCount: withProvenance.length,
        changed: result.changed,
        collisions: result.collisions.map(safeIssueText),
        deduped: result.deduped.map((d) => ({
          kept: safeIssueText(d.kept),
          dropped: safeIssueText(d.dropped),
          // pass-7: stable source keys never leave storage — keyed src
          // handles projected through the complete-domain source scope
          ...(d.sourceKey !== undefined ? { sourceKey: sourceScope.project(d.sourceKey) } : {}),
        })),
        beforeNames: before.slice(0, 50).map(safeIssueText),
        afterNames: after.slice(0, 50).map(safeIssueText),
        truncated: before.length > 50,
      },
      references: {
        // pass-7: raw profile UUIDs never leave storage — keyed opaque
        // handles, projected through ONE collision-checked scope over the
        // COMPLETE consuming-profile set (round-1 typed HandleScopes).
        consumingProfiles: (() => {
          const scope = buildProfileScope(
            GLOBAL_NAMING_SCOPE_ID,
            consuming.map((p) => p.id),
          );
          return consuming.map((p) => ({
            id: scope.project(`profile:${p.id}`),
            name: p.name,
          }));
        })(),
        orphaned: await orphanedReferenceIssues(before, after),
      },
    });
  }
  const collection = await getCollection(id);
  if (!collection) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  const managedDecoded = buildOperatorSnapshot(collection).managed?.decoded;
  const managedOp =
    managedDecoded && isCurrentRenameTemplateOperator(managedDecoded) ? managedDecoded : undefined;
  const renameOp = activeRenameOp(collection.operators);
  const recommended = defaultTemplateFor(true);
  const previewOp = managedOp ?? renameOp;
  const effectiveTemplate = previewOp?.template ?? recommended;
  const subs = await listSubscriptions();
  const { merged, ordinalPlanningSession, ordinalDomainRegistry } =
    await mergeCollectionMemberProxies(collection, subs, { writeCache: false });
  // round-1: same complete-domain projection as the subscription branch.
  const reports = analyzeSourceFacts(merged, { rules: previewOp?.recognitionRules });
  const { scope: nodeScope } = buildNodeSnapshotScope(merged);
  const sourceScope = buildSourceAliasScope(reports.map((r) => r.sourceKey));
  const health = reports.map((report) => ({
    ...report,
    sourceKey: sourceScope.project(report.sourceKey),
    nodeFacts: report.nodeFacts.map((f) => ({ ...f, node: nodeScope.project(f.node) })),
  }));
  const ordinals = await resolveOrdinalsFor(merged, sourceOf, {
    persist: false,
    template: effectiveTemplate,
    recognitionRules: previewOp?.recognitionRules ?? [],
    planningSession: ordinalPlanningSession,
    domainRegistry: ordinalDomainRegistry,
  });
  const result = applyRenameTemplate(
    merged,
    {
      template: effectiveTemplate,
      tw2cn: previewOp?.tw2cn,
      sourceAliases: previewOp?.sourceAliases ?? {},
      recognitionRules: previewOp?.recognitionRules ?? [],
    },
    sourceOf,
    ordinals,
  );
  const before = merged.map((p) => p.name as string);
  const after = result.proxies.map((p) => p.name as string);
  const prior = await getNamingHistory('collection', id);
  const sourceKeys = enabledCollectionMemberSubs(collection, subs).map((m) => m.name);
  const projectAliases = (a: Record<string, string>): Record<string, string> =>
    projectAliasKeysToHandles(a, sourceKeys) ?? {};
  // round-2: entity ref projected through the complete visible-union scope
  const visible = await globalNamingTargets();
  const targetScope = buildTargetRefScope(GLOBAL_NAMING_SCOPE_ID, visible);
  return finalize({
    entity: {
      type,
      ref: targetScope.project(`${type}:${id}`),
      label: collection.name,
    },
    aggregate: true,
    managed: planOf(managedOp, projectAliases),
    priorPlan: projectHistoryPlan(prior, sourceKeys),
    recommended,
    health,
    diagnostics: {
      nodeCount: merged.length,
      changed: result.changed,
      collisions: result.collisions.map(safeIssueText),
      deduped: result.deduped.map((d) => ({
        kept: safeIssueText(d.kept),
        dropped: safeIssueText(d.dropped),
        ...(d.sourceKey !== undefined ? { sourceKey: sourceScope.project(d.sourceKey) } : {}),
      })),
      beforeNames: before.slice(0, 50).map(safeIssueText),
      afterNames: after.slice(0, 50).map(safeIssueText),
      truncated: before.length > 50,
    },
    references: {
      consumingProfiles: (() => {
        const scope = buildProfileScope(
          GLOBAL_NAMING_SCOPE_ID,
          consumingProfilesOfCollection(collection.id, profiles).map((p) => p.id),
        );
        return consumingProfilesOfCollection(collection.id, profiles).map((p) => ({
          id: scope.project(`profile:${p.id}`),
          name: p.name,
        }));
      })(),
      orphaned: await orphanedReferenceIssues(before, after),
    },
  });
}

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { type, id } = Params.parse(await ctx.params);
  await requireGlobalNamingTarget(type, id);
  return Response.json({ data: await loadWorkspace(type, id) });
});

/**
 * POST — apply a new plan (persisting the current one as rollback target) or
 * roll back to the persisted prior plan. Both PATCH through the shared save
 * gate (namingApplyService): every consuming profile is preflighted against
 * the exact candidate, the planning bracket is captured BEFORE the initial
 * entity/history read, and the commit is config+version+history in ONE
 * atomic CAS (C14).
 */

export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { type, id } = Params.parse(await ctx.params);
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const body = PostBody.parse(raw);

  // READ-ONLY workspace preview variant: same shared candidate builder as
  // apply, same zero-write pipeline preview functions as the generic
  // preview routes. No save, no cache write, no audit, no CAS.
  if ('preview' in body) {
    const previewVersion = await getConfigVersion();
    await requireGlobalNamingTarget(type, id);
    const entity = type === 'subscription' ? await getSubscription(id) : await getCollection(id);
    if (!entity) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    const sourceKeys =
      type === 'subscription'
        ? [(entity as { name: string }).name]
        : enabledCollectionMemberSubs(
            entity as Parameters<typeof enabledCollectionMemberSubs>[0],
            await listSubscriptions(),
          ).map((m) => m.name);
    // src-handle keys → stable source keys (the trusted apply translation);
    // invented/ambiguous handles fail the bounded ALIAS_ERROR
    const stableAliases = resolveSourceAliasKeys(body.preview.sourceAliases, sourceKeys);
    // ONE complete plan — explicit fields win, absent fields keep the
    // current managed row's policy — the EXACT normalization apply uses
    const managedOp = buildOperatorSnapshot(entity as { operators?: unknown }).managed?.decoded;
    const candidate = namingCandidateForEntity(
      entity as { operators?: unknown },
      completeNamingPlan(
        {
          template: body.preview.template,
          tw2cn: body.preview.tw2cn,
          sourceAliases: stableAliases,
          recognitionRules: body.preview.recognitionRules,
        },
        priorPolicyOf(managedOp),
      ),
    );
    const preview =
      type === 'subscription'
        ? await previewNamingSubscription(id, candidate.operators)
        : await previewNamingCollection(id, candidate.operators);
    await assertReadScopeSnapshot(type, id, previewVersion);
    return Response.json({
      data: {
        after: preview.after,
        issues: preview.issues,
        candidate: { id: candidate.id, index: candidate.index, mode: candidate.mode },
      },
    });
  }

  const actor = resolveActor(request);
  // The administrator workspace edits globally shared subscription entities.
  // Config-version CAS plus all-consumer preflight protects the write; the
  // profile-scoped authority remains exclusive to assistant actions.
  await requireGlobalNamingTarget(type, id);
  const audit = { actor, scope: 'global' as const };
  if ('rollback' in body) {
    // Rollback restores the persisted prior plan, clears the history field
    // AND persists a durable naming-source audit event in ONE atomic
    // transition (config + version + history HDEL + audit).
    await rollbackNamingPlan(type, id, {
      audit,
      expectedVersion: body.expectedVersion,
    });
    return Response.json({ data: await loadWorkspace(type, id) });
  }

  // Apply persists the COMPLETE prior state as the rollback target and
  // commits config + version + history HSET + durable audit in ONE atomic
  // transition.
  await applyNamingPlan(type, id, body.apply, {
    audit,
    expectedVersion: body.expectedVersion,
  });
  return Response.json({ data: await loadWorkspace(type, id) });
});
