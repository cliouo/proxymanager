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
  let inverse: AuditEvent;

  switch (event.op) {
    case 'rule.create': {
      if (!event.after) {
        throw ProblemDetailsError.unprocessable(
          'Cannot undo rule.create event: missing after-state.',
        );
      }
      const current = await getRule(event.ruleId);
      if (!current) {
        throw ProblemDetailsError.conflict(
          `Rule ${event.ruleId} no longer exists; nothing to undo.`,
        );
      }
      if (current.updated_at !== event.after.updated_at) {
        throw ProblemDetailsError.conflict(
          `Rule ${event.ruleId} was modified after this event; refuse to undo.`,
        );
      }
      const removed = await deleteRule(event.ruleId);
      if (!removed) {
        throw ProblemDetailsError.conflict(
          `Rule ${event.ruleId} could not be deleted (already gone).`,
        );
      }
      inverse = await recordEvent({
        op: 'rule.delete',
        actor,
        ruleId: event.ruleId,
        before: current,
        undoes: event.id,
      });
      break;
    }

    case 'rule.delete': {
      if (!event.before) {
        throw ProblemDetailsError.unprocessable(
          'Cannot undo rule.delete event: missing before-state.',
        );
      }
      const existing = await getRule(event.ruleId);
      if (existing) {
        throw ProblemDetailsError.conflict(
          `Rule ${event.ruleId} already exists; nothing to restore.`,
        );
      }
      const parsedBase = await loadParsedBase();
      ensureValidAnchorAndPolicy(event.before, parsedBase);
      const restored: Rule = { ...event.before, updated_at: nowSeconds() };
      await upsertRule(restored);
      inverse = await recordEvent({
        op: 'rule.create',
        actor,
        ruleId: restored.id,
        after: restored,
        undoes: event.id,
      });
      break;
    }

    case 'rule.update': {
      if (!event.before || !event.after) {
        throw ProblemDetailsError.unprocessable(
          'Cannot undo rule.update event: missing before- or after-state.',
        );
      }
      const current = await getRule(event.ruleId);
      if (!current) {
        throw ProblemDetailsError.conflict(
          `Rule ${event.ruleId} no longer exists; nothing to revert.`,
        );
      }
      if (current.updated_at !== event.after.updated_at) {
        throw ProblemDetailsError.conflict(
          `Rule ${event.ruleId} was modified after this event; refuse to revert.`,
        );
      }
      const parsedBase = await loadParsedBase();
      ensureValidAnchorAndPolicy(event.before, parsedBase);
      const reverted: Rule = { ...event.before, updated_at: nowSeconds() };
      await upsertRule(reverted);
      inverse = await recordEvent({
        op: 'rule.update',
        actor,
        ruleId: event.ruleId,
        before: current,
        after: reverted,
        undoes: event.id,
      });
      break;
    }
  }

  await markUndone(event.id, inverse.id);
  return Response.json({ data: { event: { ...event, undone_by: inverse.id }, inverse } });
});
