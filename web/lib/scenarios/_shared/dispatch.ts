/**
 * Scenario dispatcher.
 *
 * Translates a `{scenario, op, payload}` request into a handler call,
 * persists the events the handler emits, and returns its data.
 *
 * The handler does the actual work. The dispatcher is responsible for:
 *   - looking up scenario + op in the registry
 *   - constructing the OpContext with scoped stores
 *   - running the handler
 *   - recording audit events with the canonical `${scenario}.${action}` op
 *     string (so audit log is uniform across hand-written rule.* events and
 *     scenario-routed events)
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { recordEvent } from '@/lib/repos/auditRepo';
import { getRule as getRuleRepo, listRules as listRulesRepo } from '@/lib/repos/rulesRepo';
import { preflightAndCommitProfileChanges } from '@/lib/services/profileConfigMutationService';
import { computeNextRank } from '@/lib/services/rulesService';
import type { AuditEvent } from '@/schemas';
import { getScenario } from '../registry';
import { createBaseStore } from './baseMutator';
import { createTaxonomyStore } from './GroupTaxonomy';
import type { OpContext, RulesStore } from './types';

export interface DispatchRequest {
  scenario: string;
  op: string;
  payload: unknown;
  actor: string;
  /** The profile whose base/rules/proxy-groups this op mutates. */
  profileId: string;
}

export interface DispatchResponse {
  data: unknown;
  events: AuditEvent[];
}

function createRulesStore(profileId: string, expectedConfigVersion: number): RulesStore {
  return {
    async list(filter) {
      const all = await listRulesRepo(profileId);
      if (!filter?.anchor) return all;
      return all.filter((r) => r.anchor === filter.anchor);
    },
    get: (id) => getRuleRepo(profileId, id),
    upsert: async (rule) => {
      await preflightAndCommitProfileChanges(
        profileId,
        { ruleWrites: [rule] },
        expectedConfigVersion,
      );
    },
    delete: async (id) => {
      const current = await getRuleRepo(profileId, id);
      if (!current) return false;
      await preflightAndCommitProfileChanges(
        profileId,
        { ruleDeletes: [id] },
        expectedConfigVersion,
      );
      return true;
    },
    computeNextRank: (anchor) => computeNextRank(profileId, anchor),
  };
}

export async function dispatch(req: DispatchRequest): Promise<DispatchResponse> {
  const scenario = getScenario(req.scenario);
  if (!scenario) {
    throw ProblemDetailsError.notFound(`Unknown scenario "${req.scenario}".`);
  }
  if (scenario.descriptor.scope === 'device') {
    throw ProblemDetailsError.unprocessable(
      `场景「${req.scenario}」是设备级功能，不能通过 profile 级 /api/v1/ops 写入；请使用具体设备的 features 子资源。`,
    );
  }
  const handler = scenario.ops[req.op];
  if (!handler) {
    throw ProblemDetailsError.notFound(
      `Scenario "${req.scenario}" has no op "${req.op}". Known: ${Object.keys(scenario.ops).join(', ') || '(none)'}.`,
    );
  }

  // Capture before the handler's first resource read. The preflight helper
  // compares this planning generation with its stable snapshot, closing the
  // read→candidate TOCTOU window (not only preflight→commit).
  const configVersion = await getConfigVersion();
  const ctx: OpContext = {
    actor: req.actor,
    profileId: req.profileId,
    configVersion,
    base: createBaseStore(req.profileId),
    rules: createRulesStore(req.profileId, configVersion),
    taxonomy: createTaxonomyStore(req.profileId),
  };

  const result = await handler(ctx, req.payload);

  const recorded: AuditEvent[] = [];
  for (const ev of result.events) {
    const fullOp = `${req.scenario}.${ev.action}`;
    recorded.push(
      await recordEvent({
        op: fullOp,
        actor: req.actor,
        target: ev.target,
        ruleId: ev.target.kind === 'rule' ? ev.target.id : undefined,
        before: ev.before,
        after: ev.after,
        profileId: req.profileId,
      }),
    );
  }

  return { data: result.data, events: recorded };
}
