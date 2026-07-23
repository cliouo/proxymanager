/**
 * `rule-anchor-append` — first real scenario, lifted from the original
 * /api/v1/rules CRUD path.
 *
 * Owns: appending DOMAIN / DOMAIN-SUFFIX (etc.) rules under named anchors
 * declared inside base.yaml's `rules:` block via `=== ANCHOR: foo ===`
 * comments. Renderer splices these in at subscription-fetch time.
 *
 * Storage: still the `rules` Hash in Redis (auxiliary store, not base.yaml).
 * The base.yaml structure isn't touched by this scenario — anchors must
 * exist before rules can be appended.
 *
 * Ops + inverses:
 *   create        → delete
 *   update        → update (back to `before`)
 *   patch         → patch  (back to `before` via full replace)
 *   delete        → create (re-upsert the `before` rule)
 *   batch-create  → batch-delete (delete each ruleId in the batch)
 *
 * Concurrency: rule.updated_at acts as the optimistic version. Inverse
 * handlers refuse with 409 if the live rule has moved past the snapshot.
 */

import { z } from 'zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';
import {
  ensureValidAnchorAndPolicy,
  ensureValidRuleSetRef,
  generateRuleId,
  loadParsedBase,
  loadProviderNames,
  nowSeconds,
} from '@/lib/services/rulesService';
import {
  assertMergedRuleRenderable,
  RuleCreateSchema,
  RulePatchSchema,
  RuleReplaceSchema,
  type Rule,
} from '@/schemas';
import type {
  AuditEventInput,
  InverseHandler,
  OpContext,
  OpHandler,
  OpResult,
  Scenario,
} from '../_shared/types';

/* ─── Op payload schemas ────────────────────────────────────────────── */

const CreatePayloadSchema = RuleCreateSchema;
const ReplacePayloadSchema = z.object({
  id: z.uuid(),
  rule: RuleReplaceSchema,
});
const PatchPayloadSchema = z.object({
  id: z.uuid(),
  patch: RulePatchSchema,
});
const DeletePayloadSchema = z.object({
  id: z.uuid(),
});
const BatchCreatePayloadSchema = z.object({
  rules: z.array(RuleCreateSchema).min(1).max(500),
});

/* ─── Handlers ──────────────────────────────────────────────────────── */

const create: OpHandler = async (ctx, raw) => {
  const input = CreatePayloadSchema.parse(raw);
  const parsedBase = await loadParsedBase(ctx.profileId);
  ensureValidAnchorAndPolicy(input, parsedBase);
  if (input.type === 'RULE-SET') ensureValidRuleSetRef(input, await loadProviderNames());

  const rank = input.rank ?? (await ctx.rules.computeNextRank(input.anchor));
  const now = nowSeconds();
  const rule: Rule = {
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
  };
  await ctx.rules.upsert(rule);

  return {
    data: rule,
    events: [
      {
        action: 'create',
        target: { kind: 'rule', id: rule.id },
        after: rule,
      },
    ],
  };
};

const replace: OpHandler = async (ctx, raw) => {
  const { id, rule: body } = ReplacePayloadSchema.parse(raw);
  const existing = await ctx.rules.get(id);
  if (!existing) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  const parsedBase = await loadParsedBase(ctx.profileId);
  ensureValidAnchorAndPolicy(body, parsedBase);
  if (body.type === 'RULE-SET') ensureValidRuleSetRef(body, await loadProviderNames());

  const updated: Rule = {
    id,
    anchor: body.anchor,
    type: body.type,
    value: body.value,
    policy: body.policy,
    rank: body.rank,
    source: body.source,
    note: body.note,
    options: body.options,
    enabled: body.enabled,
    added_at: existing.added_at,
    updated_at: nowSeconds(),
  };
  await ctx.rules.upsert(updated);

  return {
    data: updated,
    events: [
      {
        action: 'update',
        target: { kind: 'rule', id },
        before: existing,
        after: updated,
      },
    ],
  };
};

const patch: OpHandler = async (ctx, raw) => {
  const { id, patch: body } = PatchPayloadSchema.parse(raw);
  const existing = await ctx.rules.get(id);
  if (!existing) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  const updated: Rule = { ...existing, ...body, updated_at: nowSeconds() };
  if (body.anchor !== undefined || body.policy !== undefined) {
    const parsedBase = await loadParsedBase(ctx.profileId);
    ensureValidAnchorAndPolicy({ anchor: updated.anchor, policy: updated.policy }, parsedBase);
  }
  // P2-3 / P2-4: RulePatchSchema alone lets `value:''` (empty a DOMAIN rule) or
  // a newline through — the MERGED rule is what gets rendered, so re-check it.
  assertMergedRuleRenderable(updated);
  if ((body.type !== undefined || body.value !== undefined) && updated.type === 'RULE-SET') {
    ensureValidRuleSetRef(updated, await loadProviderNames());
  }
  await ctx.rules.upsert(updated);

  return {
    data: updated,
    events: [
      {
        action: 'update',
        target: { kind: 'rule', id },
        before: existing,
        after: updated,
      },
    ],
  };
};

const del: OpHandler = async (ctx, raw) => {
  const { id } = DeletePayloadSchema.parse(raw);
  const existing = await ctx.rules.get(id);
  if (!existing) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  const removed = await ctx.rules.delete(id);
  if (!removed) throw ProblemDetailsError.notFound(`Rule ${id} not found.`);

  return {
    data: null,
    events: [
      {
        action: 'delete',
        target: { kind: 'rule', id },
        before: existing,
      },
    ],
  };
};

const batchCreate: OpHandler = async (ctx, raw) => {
  const { rules: inputs } = BatchCreatePayloadSchema.parse(raw);
  const parsedBase = await loadParsedBase(ctx.profileId);

  // Pre-validate everything; refuse the whole batch if any anchor/policy is invalid.
  const providerNames = inputs.some((r) => r.type === 'RULE-SET')
    ? await loadProviderNames()
    : new Set<string>();
  for (const r of inputs) {
    ensureValidAnchorAndPolicy(r, parsedBase);
    if (r.type === 'RULE-SET') ensureValidRuleSetRef(r, providerNames);
  }

  // Compute starting rank per anchor once.
  const nextRankByAnchor = new Map<string, number>();
  const writes: Rule[] = [];
  const outcomes: Array<{ status: 'ok'; ruleId: string }> = [];
  const events: AuditEventInput[] = [];
  const now = nowSeconds();

  for (const r of inputs) {
    let rank: number;
    if (r.rank !== undefined) {
      rank = r.rank;
    } else {
      const cached = nextRankByAnchor.get(r.anchor);
      if (cached === undefined) {
        rank = await ctx.rules.computeNextRank(r.anchor);
      } else {
        rank = cached;
      }
      nextRankByAnchor.set(r.anchor, rank + 10);
    }
    const rule: Rule = {
      id: generateRuleId(),
      anchor: r.anchor,
      type: r.type,
      value: r.value,
      policy: r.policy,
      rank,
      source: r.source,
      added_at: now,
      updated_at: now,
      note: r.note,
      options: r.options,
      enabled: r.enabled,
    };
    writes.push(rule);
    outcomes.push({ status: 'ok', ruleId: rule.id });
    events.push({ action: 'create', target: { kind: 'rule', id: rule.id }, after: rule });
  }

  await preflightAndCommitProfileChanges(ctx.profileId, { ruleWrites: writes }, ctx.configVersion);
  return { data: { outcomes, rules: writes }, events };
};

/* ─── Inverses ──────────────────────────────────────────────────────── */

const inverseCreate: InverseHandler = async (ctx, event) => {
  const after = event.after as Rule | undefined;
  const ruleId = event.ruleId ?? (event.target?.kind === 'rule' ? event.target.id : undefined);
  if (!after || !ruleId) {
    throw ProblemDetailsError.unprocessable('Event missing after-state or ruleId.');
  }
  const current = await ctx.rules.get(ruleId);
  if (!current) {
    throw ProblemDetailsError.conflict(`Rule ${ruleId} no longer exists; nothing to undo.`);
  }
  if (current.updated_at !== after.updated_at) {
    throw ProblemDetailsError.conflict(
      `Rule ${ruleId} was modified after this event; refuse to undo.`,
    );
  }
  await ctx.rules.delete(ruleId);
  return {
    data: null,
    events: [
      {
        action: 'delete',
        target: { kind: 'rule', id: ruleId },
        before: current,
      },
    ],
  };
};

const inverseDelete: InverseHandler = async (ctx, event) => {
  const before = event.before as Rule | undefined;
  const ruleId = event.ruleId ?? (event.target?.kind === 'rule' ? event.target.id : undefined);
  if (!before || !ruleId) {
    throw ProblemDetailsError.unprocessable('Event missing before-state or ruleId.');
  }
  const existing = await ctx.rules.get(ruleId);
  if (existing) {
    throw ProblemDetailsError.conflict(`Rule ${ruleId} already exists; nothing to restore.`);
  }
  const parsedBase = await loadParsedBase(ctx.profileId);
  ensureValidAnchorAndPolicy(before, parsedBase);
  const restored: Rule = { ...before, updated_at: nowSeconds() };
  await ctx.rules.upsert(restored);
  return {
    data: restored,
    events: [
      {
        action: 'create',
        target: { kind: 'rule', id: restored.id },
        after: restored,
      },
    ],
  };
};

const inverseUpdate: InverseHandler = async (ctx, event) => {
  const before = event.before as Rule | undefined;
  const after = event.after as Rule | undefined;
  const ruleId = event.ruleId ?? (event.target?.kind === 'rule' ? event.target.id : undefined);
  if (!before || !after || !ruleId) {
    throw ProblemDetailsError.unprocessable('Event missing before/after-state or ruleId.');
  }
  const current = await ctx.rules.get(ruleId);
  if (!current) {
    throw ProblemDetailsError.conflict(`Rule ${ruleId} no longer exists; nothing to revert.`);
  }
  if (current.updated_at !== after.updated_at) {
    throw ProblemDetailsError.conflict(
      `Rule ${ruleId} was modified after this event; refuse to revert.`,
    );
  }
  const parsedBase = await loadParsedBase(ctx.profileId);
  ensureValidAnchorAndPolicy(before, parsedBase);
  const reverted: Rule = { ...before, updated_at: nowSeconds() };
  await ctx.rules.upsert(reverted);
  return {
    data: reverted,
    events: [
      {
        action: 'update',
        target: { kind: 'rule', id: ruleId },
        before: current,
        after: reverted,
      },
    ],
  };
};

/* ─── Convenience: shim that re-exports a dispatcher-style call ──────── */

/**
 * Call from the legacy REST route shims. Wraps the dispatcher signature so
 * routes stay one-liners.
 */
export async function runRuleOp(ctx: OpContext, op: string, payload: unknown): Promise<OpResult> {
  const handler = ruleAnchorAppendScenario.ops[op];
  if (!handler) {
    throw ProblemDetailsError.notFound(`Unknown rule op "${op}".`);
  }
  return handler(ctx, payload);
}

/* ─── Scenario export ───────────────────────────────────────────────── */

export const ruleAnchorAppendScenario: Scenario = {
  descriptor: {
    id: 'rule-anchor-append',
    title: '规则',
    description: '管理 base.yaml 锚点下的规则列表，按锚点 / 策略 / 类型筛选。',
    // 页面住在一级路由 /rules;旧路径 /scenarios/rule-anchor-append 仅存跳转壳。
    navHref: '/rules',
  },
  ops: {
    create,
    replace,
    patch,
    delete: del,
    'batch-create': batchCreate,
  },
  inverses: {
    create: inverseCreate,
    update: inverseUpdate,
    delete: inverseDelete,
  },
};
