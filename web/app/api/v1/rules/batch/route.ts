import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { recordEvent } from '@/lib/repos/auditRepo';
import { batchUpsertAndDelete, listRules } from '@/lib/repos/rulesRepo';
import {
  computeNextRank,
  ensureValidAnchorAndPolicy,
  generateRuleId,
  loadParsedBase,
  nowSeconds,
  resolveActor,
} from '@/lib/services/rulesService';
import { BatchRequestSchema, type BatchOpResult, type Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { ops } = BatchRequestSchema.parse(raw);

  const parsedBase = await loadParsedBase();
  const existing = await listRules();
  const existingMap = new Map(existing.map((r) => [r.id, r]));

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
    const start = await computeNextRank(anchor);
    nextRankCache.set(anchor, start + 10);
    return start;
  }

  for (const op of ops) {
    try {
      if (op.op === 'create') {
        ensureValidAnchorAndPolicy(op.rule, parsedBase);
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
      } else {
        throw err;
      }
    }
  }

  await batchUpsertAndDelete(writes, removes);

  // Emit audit events serially after the commit lands. recordEvent is fast on
  // Upstash pipelines, and at batch sizes we expect (tens, not thousands) the
  // extra latency is acceptable.
  const actor = resolveActor(request);
  for (const ev of pendingEvents) {
    if (ev.op === 'rule.create') {
      await recordEvent({ op: 'rule.create', actor, ruleId: ev.after.id, after: ev.after });
    } else if (ev.op === 'rule.update') {
      await recordEvent({
        op: 'rule.update',
        actor,
        ruleId: ev.after.id,
        before: ev.before,
        after: ev.after,
      });
    } else {
      await recordEvent({
        op: 'rule.delete',
        actor,
        ruleId: ev.before.id,
        before: ev.before,
      });
    }
  }

  const allSucceeded = results.every((r) => r.status < 400);
  return Response.json({ results }, { status: allSucceeded ? 200 : 207 });
});
