/**
 * The SINGLE audited apply/rollback path for the 智能命名 workspace (C14).
 *
 * Both the workspace route's POST and the assistant's save_naming_plan write
 * through here — one bracket, one gate, one atomic CAS, one history record:
 *
 *   1. capture planningVersion BEFORE the first entity/history read — a
 *      concurrent write at ANY later point (during reads, discovery,
 *      preflight, or the CAS itself) surfaces as a 412/409 and is never
 *      overwritten;
 *   2. read the entity + prior plan INSIDE that bracket and derive the exact
 *      candidate;
 *   3. preflight every consuming profile against that candidate via
 *      commitUnderPipelineGate (which re-verifies the generation before and
 *      after the preflight);
 *   4. commit config record + config:version + naming-history set/clear in
 *      ONE atomic eval (namingCasRepo) — a wrongtype/malformed/overflow or
 *      CAS-mismatch fails the script before any write;
 *   5. invalidate the resolved-config snapshot.
 *
 * Apply persists the COMPLETE prior state (including `hadManaged: false`) as
 * the rollback target; rollback restores it and clears the history field in
 * the same atomic transition. Assistant apply therefore produces exactly the
 * same rollback capability as UI apply.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { summarizeTemplate, validateTemplate } from '@/lib/proxies/naming';
import { redactSensitiveText } from '@/lib/proxies/namingSanitize';
import { NamingAuditEventSchema } from '@/schemas/audit';
import { getNamingHistory, type NamingHistoryPlan } from '@/lib/repos/namingHistoryRepo';
import { commitEntityWithNamingHistory } from '@/lib/repos/namingCasRepo';
import { resolveSourceAliasKeys } from '@/lib/services/sourceAliasResolver';
import {
  assertNamingMembershipUnchanged,
  captureNamingMembership,
  NAMING_SCOPE_ERROR,
  type NamingMembershipSnapshot,
} from '@/lib/services/namingTargetScope';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { REDIS_KEYS } from '@/lib/redis/keys';
import {
  RAW_OPERATORS,
  buildOperatorSnapshot,
  restoreRawOperators,
  type OperatorSnapshot,
  type WithRawOperators,
} from '@/lib/repos/rawOperators';
import { safeJsonClone, safeJsonStringify } from '@/lib/security/safeJson';
import { applyOperatorMutation } from '@/lib/services/operatorMutationPolicy';
import { buildManagedCandidate, completeNamingPlan } from '@/lib/services/namingManagedCandidate';
import {
  commitUnderPipelineGate,
  consumingProfilesOfCollection,
  consumingProfilesOfSubscription,
} from '@/lib/services/nodePipelineSaveGate';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { getProfile, listProfiles } from '@/lib/repos/profilesRepo';
import { getSubscription, nowSeconds } from '@/lib/services/subscriptionService';
import { getCollection } from '@/lib/services/collectionService';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import {
  hasOwnCompatibilityIssue,
  StoredOperatorListSchema,
  type Collection,
  type Operator,
  type Profile,
  type Subscription,
} from '@/schemas';

export interface NamingApplyPlan {
  /** Required on the apply path; a legacy prior row restores via rawOp. */
  template?: string;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: Array<{ pattern: string; field: string; value: string }>;
  /** Restore-only fields (rollback): the exact prior row identity/position. */
  opId?: string;
  position?: number;
  disabled?: boolean;
  /**
   * The FULL raw prior operator row, byte-exact (rollback restores it
   * VERBATIM — preset/components, passthrough future fields, opaque fields
   * and the exact id/disabled flags all survive; nothing is narrowed through
   * the operator or history schemas).
   */
  rawOp?: Record<string, unknown>;
}

export interface NamingApplyResult {
  /** Version captured before the initial entity/history read (the bracket). */
  planningVersion: number;
  /** Version the CAS committed under — always equals planningVersion. */
  confirmedVersion: number;
  history: 'created' | 'cleared';
  mode: 'added' | 'replaced' | 'removed';
  /** Human label of the edited source (for audit summaries). */
  label: string;
}

export type NamingAuditRequest = {
  /** Sanitized + bounded inside the builder (never merely sliced). */
  actor: string;
} & (
  | {
      /** Authenticated administrator workspace over globally shared sources. */
      scope: 'global';
      profileId?: never;
    }
  | {
      /** Profile-scoped assistant/tool authority. */
      scope?: 'profile';
      profileId: string;
    }
);

/** Sanitize ANY string that can leave storage (audit persistence): redact
 * credential-shaped content (URLs/tokens/UUIDs), collapse whitespace, bound. */
function sanitizeStorageText(value: string, bound: number, fallback: string): string {
  const cleaned = redactSensitiveText(value).replace(/\s+/g, ' ').trim();
  return (cleaned === '' ? fallback : cleaned).slice(0, bound);
}

/**
 * Build the durable naming-source audit event BEFORE the atomic CAS. The
 * payload is sanitized + bounded field-by-field (actor redacted, labels
 * bounded), the raw template is structurally summarized, its global/profile
 * authority is explicit, and the payload is validated against the strict
 * NamingAuditEventSchema — an invalid payload throws HERE, so a bad audit
 * can never reach the transition.
 * The same builder serves the workspace UI route AND the assistant action,
 * so every successful apply/rollback creates exactly one event.
 */
export function buildNamingAudit(
  options: {
    op: 'naming.apply' | 'naming.rollback';
    actor: string;
    type: 'subscription' | 'collection';
    id: string;
    label: string;
    hadManaged: boolean;
    template?: string;
    mode: 'added' | 'replaced' | 'removed';
  } & ({ scope: 'global'; profileId?: never } | { scope?: 'profile'; profileId: string }),
): {
  id: string;
  ts: number;
  op: 'naming.apply' | 'naming.rollback';
  actor: string;
  payloadJson: string;
} {
  const id = crypto.randomUUID();
  const ts = Date.now();
  // NEVER the raw template string — a bounded structural summary
  // (placeholder count + length from the shared closed-DSL parser).
  const templateSummary = summarizeTemplate(options.template);
  const payload = {
    id,
    ts,
    op: options.op,
    actor: sanitizeStorageText(options.actor, 64, 'unknown'),
    target: {
      kind: 'naming-source' as const,
      type: options.type,
      id: options.id,
      name: sanitizeStorageText(options.label, 64, options.id),
    },
    before: options.hadManaged ? { hadManaged: true } : null,
    after: {
      templateSummary: {
        placeholderCount: templateSummary.placeholderCount,
        length: templateSummary.length,
      },
      mode: options.mode,
    },
    undoable: false,
    ...(options.scope === 'global'
      ? { scope: 'global' as const }
      : { profileId: options.profileId }),
  };
  const parsed = NamingAuditEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw ProblemDetailsError.unprocessable(
      `审计事件不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
    );
  }
  return {
    id,
    ts,
    op: options.op,
    actor: payload.actor,
    payloadJson: safeJsonStringify(parsed.data),
  };
}

/** The RAW persisted operator array (byte-exact) when the parsed record
 * carries it — apply/rollback then write the untouched rows VERBATIM
 * instead of their lossy decoded views. Falls back to the decoded array
 * only for symbol-less records (test fixtures / legacy reads). */
function rawOperatorsOf(entity: Subscription | Collection): unknown[] {
  const raw = (entity as WithRawOperators<Subscription | Collection>)[RAW_OPERATORS];
  return (raw ?? entity.operators ?? []) as unknown[];
}

/** A hadManaged prior plan must carry its template UNLESS the full raw row
 * is available (a pre-DSL legacy row has preset/components and no template —
 * rollback reinstates it verbatim from rawOp). Corrupt history fails closed. */
function applyPlanFromHistory(prior: NamingHistoryPlan): NamingApplyPlan {
  if (!prior.template && prior.rawOp === undefined) {
    throw ProblemDetailsError.unprocessable('持久化的上一方案不完整，无法回滚。');
  }
  return {
    template: prior.template,
    tw2cn: prior.tw2cn,
    sourceAliases: prior.sourceAliases,
    recognitionRules: prior.recognitionRules,
    opId: prior.opId,
    position: prior.position,
    disabled: prior.disabled,
    rawOp:
      prior.rawOp !== undefined && typeof prior.rawOp === 'object' && prior.rawOp !== null
        ? (prior.rawOp as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Apply/rollback validate the resulting list against the STORED-format
 * decoder (StoredOperatorListSchema) — untouched raw rows are persisted
 * bytes the storage layer accepts BY DEFINITION, and the write schema would
 * wrongly reject pre-DSL rows (legacy preset/components rename-templates,
 * historical filter-regex `mode`, unknown passthrough fields), making
 * apply/rollback impossible on legacy pipelines. The NEW rename op itself is
 * template-validated and schema-validated at the API/action layer. The parse
 * runs for validation only; the rows are written verbatim (never narrowed
 * through the decode).
 */
function assertStoredListContract(ops: readonly unknown[]): void {
  const parsed = StoredOperatorListSchema.safeParse(ops);
  if (!parsed.success) {
    throw ProblemDetailsError.badRequest(
      `算子列表不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
    );
  }
}

/**
 * Validate the CURRENT-WRITE projection of a candidate list (finding 3):
 * untouched raw rows are never narrowed, but the EXECUTABLE projection (the
 * storage decoder's output, parked/invalid rows excluded) must satisfy the
 * current write constraints — unique ids, at most one managed
 * rename-template, and no ENABLED name-changing rename-regex/flag-emoji
 * after the managed template. Rejects BEFORE any write.
 */
function assertCurrentWriteProjection(ops: readonly unknown[]): void {
  const parsed = StoredOperatorListSchema.safeParse(ops);
  if (!parsed.success) {
    throw ProblemDetailsError.badRequest(
      `算子列表不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
    );
  }
  const decoded = parsed.data;
  const executable = decoded.filter(
    (op) =>
      (op as { disabled?: boolean }).disabled !== true &&
      (op as { kind?: string }).kind !== '__incompatible__' &&
      !hasOwnCompatibilityIssue(op),
  );
  const seen = new Set<string>();
  for (const op of decoded) {
    const id = (op as { id?: string }).id;
    if (id === undefined || id === '') continue;
    if (seen.has(id)) {
      throw ProblemDetailsError.badRequest(`算子 id 重复：${id}`);
    }
    seen.add(id);
  }
  const managedTemplates = executable.filter(
    (op) => (op as { kind?: string }).kind === 'rename-template',
  );
  if (managedTemplates.length > 1) {
    throw ProblemDetailsError.badRequest('「名称统一」步骤最多只能启用一个。');
  }
  let managedSeen = false;
  for (const op of executable) {
    const kind = (op as { kind?: string }).kind;
    if (kind === 'rename-template') {
      managedSeen = true;
      continue;
    }
    if (!managedSeen) continue;
    if (kind === 'rename-regex' || kind === 'flag-emoji') {
      throw ProblemDetailsError.badRequest(
        `「名称统一」是最终改名阶段：它之后的 ${kind} 会二次改名，已拒绝。`,
      );
    }
  }
}

/** isRecord guard — operator rows may be null/primitives; NEVER do property
 * access on non-records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replaceRenameOp(
  snapshot: OperatorSnapshot,
  plan: NamingApplyPlan,
  freshId: string,
  position?: number,
): { next: Operator[]; appliedIndex: number } {
  // Round-3: naming apply/rollback may touch ONLY the snapshot's LOGICAL
  // managed row (the first aligned current-valid rename-template) — never a
  // malformed/unknown/runtime-invalid row whose kind merely resembles
  // rename-template. Every other raw value is preserved verbatim in storage;
  // the naming authority validation proves the remainder structurally equal
  // in identical order.
  const next = [...snapshot.raw];
  // Byte-exact restore: when the prior RAW row was persisted, rollback
  // reinstates it VERBATIM (id, disabled, template, preset/components,
  // passthrough + opaque fields) — the decoded plan is only the fallback for
  // history entries written before rawOp existed.
  const rt: Operator =
    plan.rawOp !== undefined && isRecord(plan.rawOp)
      ? (safeJsonClone(plan.rawOp) as Operator)
      : ({
          // Restore-only fields (rollback) win; apply keeps the CURRENT op's id.
          id: plan.opId ?? 'naming-plan',
          kind: 'rename-template',
          template: plan.template ?? '',
          tw2cn: plan.tw2cn,
          sourceAliases:
            plan.sourceAliases && Object.keys(plan.sourceAliases).length > 0
              ? plan.sourceAliases
              : undefined,
          recognitionRules: plan.recognitionRules ?? [],
          disabled: plan.disabled === true ? true : undefined,
        } as Operator);
  const managed = snapshot.managed;
  if (managed !== undefined) {
    // REPLACE IN PLACE: id preserved, position unchanged (normalized by
    // construction — the managed entry IS at its raw index).
    next[managed.index] = { ...rt, id: plan.opId ?? managed.id };
    return { next: next as Operator[], appliedIndex: managed.index };
  }
  // INSERT a fresh M when none exists — parked rename-shaped rows are
  // untouched (the splice only inserts at the normalized position).
  const insertAt = Math.max(0, Math.min(position ?? plan.position ?? next.length, next.length));
  next.splice(insertAt, 0, { ...rt, id: plan.opId ?? freshId });
  return { next: next as Operator[], appliedIndex: insertAt };
}

/** Consumer-union discovery for a subscription change (mirrors patchSubscription). */
async function affectedProfilesForSubscription(
  nextEntity: Subscription,
  id: string,
  profiles: Profile[],
): Promise<{
  affected: Profile[];
  candidateSubscriptions: ((subs: Subscription[]) => Subscription[]) | undefined;
}> {
  const [collections, allSubs] = await Promise.all([listCollections(), listSubscriptions()]);
  const currentConsumers = consumingProfilesOfSubscription(
    nextEntity,
    collections,
    allSubs,
    profiles,
  );
  const nextSubs = allSubs.map((s) => (s.id === id ? nextEntity : s));
  const candidateConsumers = consumingProfilesOfSubscription(
    nextEntity,
    collections,
    nextSubs,
    profiles,
  );
  const byId = new Map<string, Profile>();
  for (const p of [...currentConsumers, ...candidateConsumers]) byId.set(p.id, p);
  return {
    affected: [...byId.values()],
    candidateSubscriptions: (subs) => subs.map((s) => (s.id === id ? nextEntity : s)),
  };
}

/** Gate capture for profile-scoped assistant applies/rollbacks. */
async function captureMembershipOrScopeError(profileId: string): Promise<NamingMembershipSnapshot> {
  const profile = await getProfile(profileId);
  if (!profile) {
    throw ProblemDetailsError.badRequest('目标不存在或不在当前配置文件的来源范围内。');
  }
  return captureNamingMembership(profile);
}

/** Canonical binding → (type, id) pair for the Lua CAS: the script
 * re-validates the live profile record field-by-field (no string concat —
 * the 5.1 harness subset forbids '..'). */
function splitProfileBinding(binding: string): { type: string; id: string } {
  const idx = binding.indexOf(':');
  if (binding === 'none') return { type: 'none', id: '' };
  if (idx === -1) return { type: binding, id: '' };
  return { type: binding.slice(0, idx), id: binding.slice(idx + 1) };
}

/** Preflight + atomic commit for one candidate, under the exact bracket. */
async function commitUnderBracket(options: {
  planningVersion: number;
  type: 'subscription' | 'collection';
  id: string;
  nextEntity: Subscription | Collection;
  history: { op: 'set' | 'del'; field: string; value?: string };
  audit: {
    id: string;
    ts: number;
    op: string;
    actor: string;
    payloadJson: string;
  };
  authority:
    | { scope: 'global' }
    | { scope: 'profile'; profileId: string; membership: NamingMembershipSnapshot };
}): Promise<void> {
  if (options.authority.scope === 'profile') {
    // Membership re-check BEFORE any write/audit (the Lua additionally
    // re-validates the profile source binding inside the eval).
    await assertNamingMembershipUnchanged(
      options.authority.profileId,
      options.authority.membership,
    );
  }
  if (!options.audit || options.audit.payloadJson === '') {
    throw ProblemDetailsError.preconditionFailed('命名写入必须携带审计信息。');
  }
  const profiles = await listProfiles();
  let affected: Profile[];
  let candidateSubscriptions: ((subs: Subscription[]) => Subscription[]) | undefined;
  let candidateCollections: ((cols: Collection[]) => Collection[]) | undefined;
  if (options.type === 'subscription') {
    const found = await affectedProfilesForSubscription(
      options.nextEntity as Subscription,
      options.id,
      profiles,
    );
    affected = found.affected;
    candidateSubscriptions = found.candidateSubscriptions;
  } else {
    affected = consumingProfilesOfCollection(options.id, profiles);
    candidateCollections = (cols) =>
      cols.map((c) => (c.id === options.id ? (options.nextEntity as Collection) : c));
  }

  await commitUnderPipelineGate({
    planningVersion: options.planningVersion,
    affected,
    candidateSubscriptions,
    candidateCollections,
    commit: (version, ordinalPlan) =>
      commitEntityWithNamingHistory({
        entityKey:
          options.type === 'subscription' ? REDIS_KEYS.subscriptions : REDIS_KEYS.collections,
        recordId: options.id,
        // restoreRawOperators: unrelated raw operator bytes stay byte-for-byte.
        recordJson: safeJsonStringify(
          restoreRawOperators(options.nextEntity as Subscription & Collection),
        ),
        expectedVersion: version,
        ordinalPlan,
        history: options.history,
        audit: options.audit,
        expectedProfileId:
          options.authority.scope === 'profile' ? options.authority.profileId : undefined,
        profileBinding:
          options.authority.scope === 'profile'
            ? {
                profileId: options.authority.profileId,
                ...splitProfileBinding(options.authority.membership.binding),
                memberIds: options.authority.membership.collectionMemberIds,
              }
            : { profileId: '', type: 'global', id: '', memberIds: [] },
      }),
  });
  invalidateResolvedSnapshot().catch(() => undefined);
}

/**
 * Apply a complete naming plan (template + every policy field). The prior
 * state — including "no managed naming existed" — is persisted as the
 * rollback target in the SAME atomic transaction as the config + version.
 * Assistant saves and UI saves are byte-for-byte the same path.
 */
export async function applyNamingPlan(
  type: 'subscription' | 'collection',
  id: string,
  plan: NamingApplyPlan,
  options?: {
    position?: number;
    /**
     * Confirmation-bound version (assistant path): the version captured on
     * the confirmation card. Fail closed BEFORE any read/preflight/write
     * when the current version no longer matches it.
     */
    expectedVersion?: number;
    /** pass-7 blocker 4: gate-captured membership bracket (confirmation
     * path). When absent the bracket is captured HERE at the entry gate —
     * before the first version/entity/history read — and re-checked from
     * current state immediately before the CAS. */
    expectedMembership?: NamingMembershipSnapshot;
    /** REQUIRED durable audit (finding 2): every naming write — UI or
     * assistant — commits exactly one sanitized event in the same CAS. */
    audit: NamingAuditRequest;
  },
): Promise<NamingApplyResult> {
  if (!options?.audit) {
    throw ProblemDetailsError.preconditionFailed('命名写入必须携带审计信息。');
  }
  // Profile-scoped assistant writes capture their membership bracket first.
  // The administrator workspace is target-global; config-version CAS plus
  // all-consumer preflight is its authority bracket.
  const authority =
    options.audit.scope === 'global'
      ? ({ scope: 'global' } as const)
      : ({
          scope: 'profile',
          profileId: options.audit.profileId,
          membership:
            options.expectedMembership ??
            (await captureMembershipOrScopeError(options.audit.profileId)),
        } as const);
  if (plan.template === undefined) {
    throw ProblemDetailsError.badRequest('模板不能为空');
  }
  const validation = validateTemplate(plan.template);
  if (!validation.ok) {
    throw ProblemDetailsError.badRequest(validation.message);
  }
  // BRACKET FIRST — before any entity/history read (C14): a concurrent write
  // between this read and the preflight/CAS fails the gate, never commits.
  const planningVersion =
    options?.expectedVersion !== undefined
      ? await assertBracketVersion(options.expectedVersion)
      : await getConfigVersion();
  const historyField = `${type}:${id}`;
  const entity = await readEntity(type, id);
  // Round-3: the LOGICAL managed row comes from the snapshot's aligned
  // classifier — a pre-existing DISABLED valid rename-template is managed
  // history too; a malformed/unknown/runtime-invalid rename-shaped row is
  // NOT (it stays parked and untouched).
  const snapshot = buildOperatorSnapshot(entity);
  const storedRaw = snapshot.raw;
  const managed = snapshot.managed;
  const priorIdx = managed?.index ?? -1;
  // A concrete projected shape (NOT `Operator & …` — a union intersection
  // distributes and keeps the property access a union again).
  const priorOp =
    priorIdx >= 0
      ? (storedRaw[priorIdx] as unknown as {
          id: string;
          kind?: string;
          template?: string;
          tw2cn?: boolean;
          sourceAliases?: Record<string, string>;
          recognitionRules?: Array<{ pattern: string; field: string; value: string }>;
          disabled?: boolean;
        })
      : undefined;
  // pass-5 blocker: the one-shot suggestion carries OPAQUE src-handle alias
  // keys; this trusted apply boundary translates accepted unambiguous
  // handles to the stable source keys the executor keys on — invented or
  // ambiguous handles fail closed. User-typed stable keys pass through.
  const sourceKeys: string[] =
    type === 'subscription'
      ? [(entity as Subscription).name]
      : enabledCollectionMemberSubs(entity as Collection, await listSubscriptions()).map(
          (m) => m.name,
        );
  const resolvedAliases = resolveSourceAliasKeys(plan.sourceAliases, sourceKeys);
  // ONE complete plan (explicit fields win; absent fields keep the current
  // row's policy) and ONE shared candidate builder — the exact same
  // derivation the workspace preview and the assistant preview use, so
  // preview and apply are byte-identical by construction (finding 4: no
  // reserved literal id, deterministic first free id over every raw id).
  const candidate = buildManagedCandidate(
    snapshot,
    completeNamingPlan(
      {
        template: plan.template,
        tw2cn: plan.tw2cn,
        sourceAliases: resolvedAliases,
        recognitionRules: plan.recognitionRules,
      },
      priorOp,
    ),
    { position: options?.position },
  );
  const next = candidate.storage;
  const freshId = candidate.id;
  // NORMALIZED actual insertion index + id of the applied row (finding 4): a
  // position=999 request splices at the clamped end — history must record the
  // REAL index so rollback targets the exact row, and the generated id must
  // be persisted for the strict position+id rollback contract.
  const appliedIdx = candidate.index;
  const priorState: NamingHistoryPlan = priorOp
    ? {
        hadManaged: true,
        template: priorOp.template,
        tw2cn: priorOp.tw2cn,
        sourceAliases: priorOp.sourceAliases,
        recognitionRules: priorOp.recognitionRules,
        opId: priorOp.id,
        position: priorIdx,
        disabled: priorOp.disabled === true,
        // byte-exact raw row: deep-cloned so later mutation of `next` can
        // never alias into the persisted history payload
        rawOp: safeJsonClone(storedRaw[priorIdx]),
      }
    : {
        hadManaged: false,
        position: appliedIdx,
        opId: freshId,
      };
  // Storage-level validation (StoredOperatorListSchema): the untouched raw
  // rows are accepted by the storage layer BY DEFINITION (they are persisted
  // rows) — the write schema would wrongly reject pre-DSL rows and make
  // apply impossible on legacy pipelines. The NEW rename op itself is
  // template-validated above and schema-validated at the API/action layer.
  assertStoredListContract(next);
  assertCurrentWriteProjection(next);
  // The SINGLE mutation-policy boundary (naming authority): apply may
  // replace/add the managed naming row but must preserve every other raw row
  // byte-for-byte in identical order; a no-op save with an unchanged plan is
  // still an authorized write and commits its audit. The PERSISTED list is
  // the authority's storage result — never an unchecked candidate.
  const namingResult = applyOperatorMutation(buildOperatorSnapshot(entity), next, 'naming');
  const nextEntity: Subscription | Collection = {
    ...entity,
    operators: namingResult.storage as Subscription['operators'],
    updated_at: nowSeconds(),
  };
  const mode = priorOp ? 'replaced' : 'added';
  const audit = buildNamingAudit({
    op: 'naming.apply',
    actor: options.audit.actor,
    ...(options.audit.scope === 'global'
      ? { scope: 'global' as const }
      : { profileId: options.audit.profileId }),
    type,
    id,
    label:
      type === 'subscription'
        ? (entity as Subscription).display_name?.trim() || (entity as Subscription).name
        : (entity as Collection).name,
    hadManaged: priorOp !== undefined,
    template: plan.template,
    mode,
  });
  await commitUnderBracket({
    planningVersion,
    type,
    id,
    nextEntity,
    history: { op: 'set', field: historyField, value: safeJsonStringify(priorState) },
    audit,
    authority,
  });
  return {
    planningVersion,
    confirmedVersion: planningVersion,
    history: 'created',
    mode,
    label:
      type === 'subscription'
        ? (entity as Subscription).display_name?.trim() || (entity as Subscription).name
        : (entity as Collection).name,
  };
}

/**
 * Roll back to the persisted prior plan (or remove the rename operator when
 * no managed naming existed before the apply). The history field is cleared
 * in the SAME atomic transaction as the config + version.
 */
export async function rollbackNamingPlan(
  type: 'subscription' | 'collection',
  id: string,
  options: {
    audit: NamingAuditRequest;
    /** pass-7 blocker 4: confirmation-bound membership bracket (assistant
     * path); UI rollbacks capture at entry. */
    expectedMembership?: NamingMembershipSnapshot;
    /** pass-8 blocker 6: gate-captured config version (UI path) — the
     * rollback commits ONLY under it; a moved version fails closed (ABA). */
    expectedVersion?: number;
  },
): Promise<NamingApplyResult> {
  if (!options.audit) {
    throw ProblemDetailsError.preconditionFailed('命名回滚必须携带审计信息。');
  }
  const authority =
    options.audit.scope === 'global'
      ? ({ scope: 'global' } as const)
      : ({
          scope: 'profile',
          profileId: options.audit.profileId,
          membership:
            options.expectedMembership ??
            (await captureMembershipOrScopeError(options.audit.profileId)),
        } as const);
  // BRACKET FIRST — same rule as apply. pass-8 blocker 6: when the caller
  // (workspace UI) captured the version at its gate, commit ONLY under it —
  // a moved version (any intermediate change, incl. ABA rebinds) fails
  // closed with zero writes/audit.
  const planningVersion =
    options.expectedVersion !== undefined
      ? await assertBracketVersion(options.expectedVersion)
      : await getConfigVersion();
  const historyField = `${type}:${id}`;
  const prior = await getNamingHistory(type, id);
  if (!prior) {
    throw ProblemDetailsError.unprocessable('没有可回滚的上一方案（尚未应用过新模板）。');
  }
  const entity = await readEntity(type, id);
  const storedOps = rawOperatorsOf(entity);
  // Remove ONLY the exact LOGICAL managed row at its recorded
  // position/identity — the aligned snapshot classifier decides what the
  // managed row IS; duplicate/parked/malformed rename-shaped rows elsewhere
  // in the pipeline are untouched bytes that must survive rollback verbatim.
  const targetIdx = prior.position;
  const rollbackSnapshot = buildOperatorSnapshot(entity);
  // STRICT contract (finding 4): rollback requires the CURRENT logical M at
  // BOTH the exact recorded position AND the exact recorded id — a
  // same-position row with a different id (pipeline edited) or a parked/
  // malformed row at the position never matches.
  const identityMatches =
    targetIdx !== undefined &&
    prior.opId !== undefined &&
    rollbackSnapshot.managed !== undefined &&
    rollbackSnapshot.managed.index === targetIdx &&
    rollbackSnapshot.managed.id === prior.opId;
  if (!identityMatches) {
    throw ProblemDetailsError.unprocessable(
      '无法定位待回滚的命名步骤（管线已被修改），请重新发起回滚。',
    );
  }
  const withoutManagedRow = storedOps.filter((_, i) => i !== targetIdx);
  let next: unknown[];
  if (!prior.hadManaged) {
    next = withoutManagedRow;
  } else if (prior.rawOp !== undefined) {
    // byte-exact restore: splice the raw prior row at its RECORDED position —
    // never replace a surviving duplicate/parked rename-template row
    const restored = safeJsonClone(prior.rawOp) as unknown;
    next = [...withoutManagedRow];
    next.splice(Math.min(prior.position ?? targetIdx, next.length), 0, restored);
  } else {
    const restored = replaceRenameOp(
      buildOperatorSnapshot({ operators: withoutManagedRow }),
      applyPlanFromHistory(prior),
      'naming-rollback',
    );
    next = restored.next as unknown[];
  }
  assertStoredListContract(next);
  assertCurrentWriteProjection(next);
  // The SINGLE mutation-policy boundary (naming authority): rollback may
  // remove/restore the managed naming row but must preserve every other raw
  // row byte-for-byte in identical order. The PERSISTED list is the
  // authority's storage result — never an unchecked candidate.
  const namingResult = applyOperatorMutation(buildOperatorSnapshot(entity), next, 'naming');
  const nextEntity: Subscription | Collection = {
    ...entity,
    operators: namingResult.storage as Subscription['operators'],
    updated_at: nowSeconds(),
  };
  const mode = prior.hadManaged ? 'replaced' : 'removed';
  const audit = buildNamingAudit({
    op: 'naming.rollback',
    actor: options.audit.actor,
    ...(options.audit.scope === 'global'
      ? { scope: 'global' as const }
      : { profileId: options.audit.profileId }),
    type,
    id,
    label:
      type === 'subscription'
        ? (entity as Subscription).display_name?.trim() || (entity as Subscription).name
        : (entity as Collection).name,
    hadManaged: prior.hadManaged,
    template: prior.template,
    mode,
  });
  await commitUnderBracket({
    planningVersion,
    type,
    id,
    nextEntity,
    history: { op: 'del', field: historyField },
    audit,
    authority,
  });
  return {
    planningVersion,
    confirmedVersion: planningVersion,
    history: 'cleared',
    mode,
    label:
      type === 'subscription'
        ? (entity as Subscription).display_name?.trim() || (entity as Subscription).name
        : (entity as Collection).name,
  };
}

/** Confirmation-bound bracket: the approved version must STILL be current —
 * otherwise the card the user saw is stale and the write fails BEFORE any
 * read, preflight or mutation. */
async function assertBracketVersion(expectedVersion: number): Promise<number> {
  const current = await getConfigVersion();
  if (current !== expectedVersion) {
    throw ProblemDetailsError.preconditionFailed(
      '配置在确认后已被其他写入修改，请重新确认后再保存。',
    );
  }
  return current;
}

async function readEntity(
  type: 'subscription' | 'collection',
  id: string,
): Promise<Subscription | Collection> {
  if (type === 'subscription') {
    const sub = await getSubscription(id);
    if (!sub) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    return sub;
  }
  const col = await getCollection(id);
  if (!col) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  return col;
}
