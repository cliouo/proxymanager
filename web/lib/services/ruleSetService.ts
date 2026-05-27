import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteRuleSet as repoDelete,
  getRuleSet,
  getRuleSetByName,
  listRuleSets,
  upsertRuleSet,
} from '@/lib/repos/ruleSetsRepo';
import { ruleSetIssues, type RuleSet, type RuleSetCreate, type RuleSetUpdate } from '@/schemas';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Throw a 422 if the (possibly merged) record violates a cross-field invariant. */
function assertInvariants(set: Pick<RuleSet, 'source' | 'format' | 'content' | 'url'>): void {
  const issues = ruleSetIssues(set);
  if (issues.length > 0) throw ProblemDetailsError.unprocessable(issues[0].message);
}

export function generateRuleSetId(): string {
  return crypto.randomUUID();
}

export async function createRuleSet(input: RuleSetCreate): Promise<RuleSet> {
  const dup = await getRuleSetByName(input.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`Rule set name "${input.name}" already exists.`);
  }
  const set: RuleSet = { ...input, id: generateRuleSetId(), updated_at: nowSeconds() };
  await upsertRuleSet(set);
  return set;
}

export async function replaceRuleSet(id: string, input: RuleSetCreate): Promise<RuleSet> {
  const current = await getRuleSet(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  }
  if (input.name !== current.name) {
    const dup = await getRuleSetByName(input.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Rule set name "${input.name}" already exists.`);
    }
  }
  const next: RuleSet = { ...input, id, updated_at: nowSeconds() };
  assertInvariants(next);
  await upsertRuleSet(next);
  return next;
}

export async function patchRuleSet(id: string, patch: RuleSetUpdate): Promise<RuleSet> {
  const current = await getRuleSet(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  }
  if (patch.name && patch.name !== current.name) {
    const dup = await getRuleSetByName(patch.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Rule set name "${patch.name}" already exists.`);
    }
  }
  const next: RuleSet = { ...current, ...patch, id, updated_at: nowSeconds() };
  assertInvariants(next);
  await upsertRuleSet(next);
  return next;
}

export {
  listRuleSets,
  getRuleSet,
  getRuleSetByName,
  repoDelete as deleteRuleSet,
};
