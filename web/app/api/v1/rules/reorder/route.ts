import { z } from '@/lib/openapi/zod';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';
import { nowSeconds } from '@/lib/services/rulesService';
import { compareRulesForEffectiveOrder, type Rule } from '@/schemas/rule';

export const dynamic = 'force-dynamic';

const ReorderRequestSchema = z
  .object({
    anchor: z.string().min(1).optional(),
    step: z.number().int().positive().max(1000).default(10),
  })
  .optional();

export const POST = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const raw = await request.json().catch(() => undefined);
  const body = ReorderRequestSchema.parse(raw) ?? { step: 10 };
  const step = body.step ?? 10;

  const planningVersion = await getConfigVersion();
  const all = await listRules(profileId);
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
    // Normalization must preserve the terminal invariant represented by the
    // actual renderer, including legacy records whose MATCH rank is too low.
    list.sort(compareRulesForEffectiveOrder);
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

  if (writes.length > 0) {
    await preflightAndCommitProfileChanges(profileId, { ruleWrites: writes }, planningVersion);
  }

  return Response.json({
    data: {
      reassigned,
      total_updated: writes.length,
      step,
    },
  });
});
