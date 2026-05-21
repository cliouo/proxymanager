import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getEvent, markUndone, recordEvent } from '@/lib/repos/auditRepo';
import { deleteRule, getRule, upsertRule } from '@/lib/repos/rulesRepo';
import {
  ensureValidAnchorAndPolicy,
  loadParsedBase,
  nowSeconds,
  resolveActor,
} from '@/lib/services/rulesService';
import type { AuditEvent, Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/history/[id]/undo'>;

export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const event = await getEvent(id);
  if (!event) throw ProblemDetailsError.notFound(`History event ${id} not found.`);
  if (event.undone_by) {
    throw ProblemDetailsError.conflict(
      `Event ${id} was already undone by ${event.undone_by}.`,
    );
  }

  const actor = resolveActor(request);
  const ruleId = event.ruleId ?? (event.target?.kind === 'rule' ? event.target.id : undefined);

  if (!ruleId || !event.op.startsWith('rule.')) {
    // Scenario-routed undo (chained-proxy, regional-groups, etc.) will be
    // dispatched through scenario inverseOps in a follow-up. For now the
    // /history page only offers Undo on rule.* events.
    throw ProblemDetailsError.unprocessable(
      `Undo is currently only supported for rule.* ops. Got "${event.op}".`,
    );
  }

  let inverse: AuditEvent;

  switch (event.op) {
    case 'rule.create': {
      const after = event.after as Rule | undefined;
      if (!after) {
        throw ProblemDetailsError.unprocessable(
          'Cannot undo rule.create event: missing after-state.',
        );
      }
      const current = await getRule(ruleId);
      if (!current) {
        throw ProblemDetailsError.conflict(
          `Rule ${ruleId} no longer exists; nothing to undo.`,
        );
      }
      if (current.updated_at !== after.updated_at) {
        throw ProblemDetailsError.conflict(
          `Rule ${ruleId} was modified after this event; refuse to undo.`,
        );
      }
      const removed = await deleteRule(ruleId);
      if (!removed) {
        throw ProblemDetailsError.conflict(
          `Rule ${ruleId} could not be deleted (already gone).`,
        );
      }
      inverse = await recordEvent({
        op: 'rule.delete',
        actor,
        ruleId,
        target: { kind: 'rule', id: ruleId },
        before: current,
        undoes: event.id,
      });
      break;
    }

    case 'rule.delete': {
      const before = event.before as Rule | undefined;
      if (!before) {
        throw ProblemDetailsError.unprocessable(
          'Cannot undo rule.delete event: missing before-state.',
        );
      }
      const existing = await getRule(ruleId);
      if (existing) {
        throw ProblemDetailsError.conflict(
          `Rule ${ruleId} already exists; nothing to restore.`,
        );
      }
      const parsedBase = await loadParsedBase();
      ensureValidAnchorAndPolicy(before, parsedBase);
      const restored: Rule = { ...before, updated_at: nowSeconds() };
      await upsertRule(restored);
      inverse = await recordEvent({
        op: 'rule.create',
        actor,
        ruleId: restored.id,
        target: { kind: 'rule', id: restored.id },
        after: restored,
        undoes: event.id,
      });
      break;
    }

    case 'rule.update': {
      const before = event.before as Rule | undefined;
      const after = event.after as Rule | undefined;
      if (!before || !after) {
        throw ProblemDetailsError.unprocessable(
          'Cannot undo rule.update event: missing before- or after-state.',
        );
      }
      const current = await getRule(ruleId);
      if (!current) {
        throw ProblemDetailsError.conflict(
          `Rule ${ruleId} no longer exists; nothing to revert.`,
        );
      }
      if (current.updated_at !== after.updated_at) {
        throw ProblemDetailsError.conflict(
          `Rule ${ruleId} was modified after this event; refuse to revert.`,
        );
      }
      const parsedBase = await loadParsedBase();
      ensureValidAnchorAndPolicy(before, parsedBase);
      const reverted: Rule = { ...before, updated_at: nowSeconds() };
      await upsertRule(reverted);
      inverse = await recordEvent({
        op: 'rule.update',
        actor,
        ruleId,
        target: { kind: 'rule', id: ruleId },
        before: current,
        after: reverted,
        undoes: event.id,
      });
      break;
    }

    default:
      throw ProblemDetailsError.unprocessable(
        `Cannot undo unknown op "${event.op}".`,
      );
  }

  await markUndone(event.id, inverse.id);
  return Response.json({ data: { event: { ...event, undone_by: inverse.id }, inverse } });
});
