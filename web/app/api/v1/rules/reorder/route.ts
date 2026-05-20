import { z } from 'zod';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { batchUpsertAndDelete, listRules } from '@/lib/repos/rulesRepo';
import { nowSeconds } from '@/lib/services/rulesService';
import type { Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

const ReorderRequestSchema = z
  .object({
    anchor: z.string().min(1).optional(),
    step: z.number().int().positive().max(1000).default(10),
  })
  .optional();

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => undefined);
  const body = ReorderRequestSchema.parse(raw) ?? { step: 10 };
  const step = body.step ?? 10;

  const all = await listRules();
  const target = body.anchor ? all.filter((r) => r.anchor === body.anchor) : all;
  if (body.anchor && target.length === 0) {
    throw ProblemDetailsError.notFound(`No rules found under anchor "${body.anchor}".`);
  }

  const byAnchor = new Map<string, Rule[]>();
  for (const rule of target) {
    const list = byAnchor.get(rule.anchor) ?? [];
    list.push(rule);
    byAnchor.set(rule.anchor, list);
  }

  const now = nowSeconds();
  const writes: Rule[] = [];
  const reassigned: Record<string, { old: number; new: number }[]> = {};

  for (const [anchor, list] of byAnchor) {
    list.sort((a, b) => a.rank - b.rank);
    const changes: { old: number; new: number }[] = [];
    list.forEach((rule, idx) => {
      const newRank = (idx + 1) * step;
      if (rule.rank !== newRank) {
        writes.push({ ...rule, rank: newRank, updated_at: now });
        changes.push({ old: rule.rank, new: newRank });
      }
    });
    if (changes.length > 0) reassigned[anchor] = changes;
  }

  await batchUpsertAndDelete(writes, []);

  return Response.json({
    data: {
      reassigned,
      total_updated: writes.length,
      step,
    },
  });
});
