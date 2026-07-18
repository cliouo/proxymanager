import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getEvent, markUndone, recordEvent } from '@/lib/repos/auditRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { getScenario } from '@/lib/scenarios/registry';
import { createBaseStore } from '@/lib/scenarios/_shared/baseMutator';
import { createTaxonomyStore } from '@/lib/scenarios/_shared/GroupTaxonomy';
import type { InverseHandler, OpContext } from '@/lib/scenarios/_shared/types';
import { getRule as getRuleRepo, listRules as listRulesRepo } from '@/lib/repos/rulesRepo';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { computeNextRank, resolveActor } from '@/lib/services/rulesService';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';
import { DEFAULT_PROFILE_NAME, type AuditEvent } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/history/[id]/undo'>;

/**
 * Parse an audit op string into a scenario+action pair. Legacy `rule.*`
 * events from before the M3-D migration are routed through the
 * rule-anchor-append scenario for inverses since the op semantics are
 * identical.
 */
function resolveInverse(opString: string): InverseHandler | null {
  const lastDot = opString.lastIndexOf('.');
  if (lastDot < 0) return null;
  const rawScenario = opString.slice(0, lastDot);
  const action = opString.slice(lastDot + 1);
  const scenarioId = rawScenario === 'rule' ? 'rule-anchor-append' : rawScenario;
  return getScenario(scenarioId)?.inverses?.[action] ?? null;
}

export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const event = await getEvent(id);
  if (!event) throw ProblemDetailsError.notFound(`History event ${id} not found.`);
  if (event.undoable === false) {
    throw ProblemDetailsError.unprocessable('该操作没有安全的原子撤销路径。');
  }
  const target = event.target;
  if (target?.kind === 'profile') {
    throw ProblemDetailsError.unprocessable('组合 profile 操作没有安全的原子撤销路径。');
  }
  if (event.undone_by) {
    throw ProblemDetailsError.conflict(`Event ${id} was already undone by ${event.undone_by}.`);
  }

  const inverse = resolveInverse(event.op);
  if (!inverse) {
    throw ProblemDetailsError.unprocessable(`No inverse registered for op "${event.op}".`);
  }

  // Undo targets the profile the original mutation touched. Legacy events
  // (pre-Phase-2) carry no profileId → fall back to the default profile.
  const configVersion = await getConfigVersion();
  const profileId = event.profileId ?? (await getProfileByName(DEFAULT_PROFILE_NAME))?.id;
  if (!profileId) {
    throw ProblemDetailsError.unprocessable(
      `Cannot undo: event has no profile and no "${DEFAULT_PROFILE_NAME}" profile exists.`,
    );
  }

  const actor = resolveActor(request);
  const opCtx: OpContext = {
    actor,
    profileId,
    configVersion,
    base: createBaseStore(profileId),
    rules: {
      async list(filter) {
        const all = await listRulesRepo(profileId);
        return filter?.anchor ? all.filter((r) => r.anchor === filter.anchor) : all;
      },
      get: (id) => getRuleRepo(profileId, id),
      upsert: async (rule) => {
        await preflightAndCommitProfileChanges(profileId, { ruleWrites: [rule] }, configVersion);
      },
      delete: async (id) => {
        const current = await getRuleRepo(profileId, id);
        if (!current) return false;
        await preflightAndCommitProfileChanges(profileId, { ruleDeletes: [id] }, configVersion);
        return true;
      },
      computeNextRank: (anchor) => computeNextRank(profileId, anchor),
    },
    taxonomy: createTaxonomyStore(profileId),
  };

  const result = await inverse(opCtx, {
    id: event.id,
    before: event.before,
    after: event.after,
    target,
    ruleId: event.ruleId,
  });

  // Record the inverse mutation as its own event, pointing back at the
  // original via `undoes`. Audit op string is derived from the original
  // scenario id (so a legacy rule.* event undone produces a
  // rule-anchor-append.* inverse — consistent with new ops going forward).
  let inverseEvent: AuditEvent | null = null;
  for (const ev of result.events) {
    const lastDot = event.op.lastIndexOf('.');
    const rawScenario = event.op.slice(0, lastDot);
    const inverseScenarioId = rawScenario === 'rule' ? 'rule-anchor-append' : rawScenario;
    const recorded = await recordEvent({
      op: `${inverseScenarioId}.${ev.action}`,
      actor,
      target: ev.target,
      ruleId: ev.target.kind === 'rule' ? ev.target.id : undefined,
      before: ev.before,
      after: ev.after,
      undoes: event.id,
      profileId,
    });
    // First emitted event is the canonical inverse; later ones (if any)
    // are bookkeeping and don't get the back-pointer on the original.
    if (!inverseEvent) inverseEvent = recorded;
  }

  if (!inverseEvent) {
    throw ProblemDetailsError.unprocessable(
      'Inverse handler emitted no events; cannot complete undo.',
    );
  }

  await markUndone(event.id, inverseEvent.id);
  return Response.json({
    data: { event: { ...event, undone_by: inverseEvent.id }, inverse: inverseEvent },
  });
});
