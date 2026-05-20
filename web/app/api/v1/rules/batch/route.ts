import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { batchUpsertAndDelete, listRules } from '@/lib/repos/rulesRepo';
import {
  computeNextRank,
  ensureValidAnchorAndPolicy,
  generateRuleId,
  loadParsedBase,
  nowSeconds,
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

  const allSucceeded = results.every((r) => r.status < 400);
  return Response.json({ results }, { status: allSucceeded ? 200 : 207 });
});
