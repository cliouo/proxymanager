import { ZodError } from 'zod';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { recordEvents } from '@/lib/repos/auditRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import {
  computeNextRank,
  ensureValidAnchorAndPolicy,
  ensureValidRuleSetRef,
  generateRuleId,
  loadParsedBase,
  loadProviderNames,
  nowSeconds,
  resolveActor,
} from '@/lib/services/rulesService';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';
import { assertMergedRuleRenderable } from '@/schemas/rule';
import { BatchRequestSchema, type BatchOpResult, type Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

export const POST = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { ops } = BatchRequestSchema.parse(raw);

  const planningVersion = await getConfigVersion();
  const parsedBase = await loadParsedBase(profileId);
  const existing = await listRules(profileId);
  const existingMap = new Map(existing.map((r) => [r.id, r]));

  // Load the rule-set library names once, only if any op could reference one.
  const needsProviderNames = ops.some(
    (op) =>
      (op.op === 'create' && op.rule.type === 'RULE-SET') ||
      (op.op === 'update' && (op.patch.type === 'RULE-SET' || op.patch.value !== undefined)),
  );
  const providerNames = needsProviderNames ? await loadProviderNames() : new Set<string>();

  const writes: Rule[] = [];
  const removes: string[] = [];
  const results: BatchOpResult[] = [];

  // Audit trail emitted post-commit. Collected during the planning loop so we
  // know exactly which ops actually succeeded once batchUpsertAndDelete runs.
  type PendingEvent =
    | { op: 'rule.create'; after: Rule }
    | { op: 'rule.update'; before: Rule; after: Rule }
    | { op: 'rule.delete'; before: Rule };
  const pendingEvents: PendingEvent[] = [];

  // Track per-anchor next-rank as we walk, so a batch of N creates against
  // the same anchor each get a unique increasing rank without N round-trips.
  const nextRankCache = new Map<string, number>();
  async function nextRankFor(anchor: string): Promise<number> {
    const cached = nextRankCache.get(anchor);
    if (cached !== undefined) {
      nextRankCache.set(anchor, cached + 10);
      return cached;
    }
    const start = await computeNextRank(profileId, anchor);
    nextRankCache.set(anchor, start + 10);
    return start;
  }

  for (const op of ops) {
    try {
      if (op.op === 'create') {
        ensureValidAnchorAndPolicy(op.rule, parsedBase);
        // P0-3: batch must enforce the same RULE-SET reference check as the
        // single-rule path — else `{type:'RULE-SET',value:'不存在'}` lands as a
        // dangling reference mihomo rejects at load.
        if (op.rule.type === 'RULE-SET') ensureValidRuleSetRef(op.rule, providerNames);
        const rank = op.rule.rank ?? (await nextRankFor(op.rule.anchor));
        const now = nowSeconds();
        const rule: Rule = {
          id: generateRuleId(),
          anchor: op.rule.anchor,
          type: op.rule.type,
          value: op.rule.value,
          policy: op.rule.policy,
          rank,
          source: op.rule.source,
          added_at: now,
          updated_at: now,
          note: op.rule.note,
          // P0-3: these were silently dropped — a `{enabled:false}` import went
          // live, a `no-resolve` modifier vanished. Carry them through.
          options: op.rule.options,
          enabled: op.rule.enabled,
        };
        writes.push(rule);
        pendingEvents.push({ op: 'rule.create', after: rule });
        results.push({ status: 201, data: rule });
      } else if (op.op === 'update') {
        const current = existingMap.get(op.id);
        if (!current) {
          results.push({
            status: 404,
            error: { title: 'Not Found', detail: `Rule ${op.id} not found.` },
          });
          continue;
        }
        const merged: Rule = { ...current, ...op.patch, updated_at: nowSeconds() };
        if (op.patch.anchor !== undefined || op.patch.policy !== undefined) {
          ensureValidAnchorAndPolicy({ anchor: merged.anchor, policy: merged.policy }, parsedBase);
        }
        // P2-3 / P2-4: a PATCH can empty a non-MATCH value or smuggle a newline;
        // re-validate the MERGED rule (not just the patch fragment) before commit.
        assertMergedRuleRenderable(merged);
        // P0-3: RULE-SET reference must stay valid after the merge, too.
        if (merged.type === 'RULE-SET') ensureValidRuleSetRef(merged, providerNames);
        writes.push(merged);
        pendingEvents.push({ op: 'rule.update', before: current, after: merged });
        results.push({ status: 200, data: merged });
      } else {
        // op.op === 'delete'
        if (!existingMap.has(op.id)) {
          results.push({
            status: 404,
            error: { title: 'Not Found', detail: `Rule ${op.id} not found.` },
          });
          continue;
        }
        removes.push(op.id);
        const before = existingMap.get(op.id);
        if (before) pendingEvents.push({ op: 'rule.delete', before });
        results.push({ status: 204 });
      }
    } catch (err) {
      if (err instanceof ProblemDetailsError) {
        results.push({
          status: err.problem.status,
          error: { title: err.problem.title, detail: err.problem.detail },
        });
      } else if (err instanceof ZodError) {
        // Per-op validation failure (empty value, YAML-hostile chars) → a 422
        // result for that op, not a whole-batch 500.
        results.push({
          status: 422,
          error: {
            title: 'Validation failed',
            detail: err.issues.map((i) => i.message).join('；'),
          },
        });
      } else {
        throw err;
      }
    }
  }

  if (writes.length > 0 || removes.length > 0) {
    await preflightAndCommitProfileChanges(
      profileId,
      {
        ruleWrites: writes,
        ruleDeletes: removes,
      },
      planningVersion,
    );
  }

  // P2-8: emit all audit events in one pipeline after the commit lands, instead
  // of a per-op serial loop that could take tens of seconds for a large batch.
  const actor = resolveActor(request);
  await recordEvents(
    pendingEvents.map((ev) =>
      ev.op === 'rule.create'
        ? { op: 'rule.create' as const, actor, ruleId: ev.after.id, after: ev.after, profileId }
        : ev.op === 'rule.update'
          ? {
              op: 'rule.update' as const,
              actor,
              ruleId: ev.after.id,
              before: ev.before,
              after: ev.after,
              profileId,
            }
          : {
              op: 'rule.delete' as const,
              actor,
              ruleId: ev.before.id,
              before: ev.before,
              profileId,
            },
    ),
  );

  const allSucceeded = results.every((r) => r.status < 400);
  return Response.json({ results }, { status: allSucceeded ? 200 : 207 });
});
