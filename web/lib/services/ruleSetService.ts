import { ProblemDetailsError } from '@/lib/http/problem';
import { referencedProviderNamesInBaseYaml } from '@/lib/engine/renderer';
import { getBase } from '@/lib/repos/baseRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listRules, upsertRules } from '@/lib/repos/rulesRepo';
import {
  deleteRuleSet as repoDelete,
  getRuleSet,
  getRuleSetByName,
  listRuleSets,
  upsertRuleSet,
} from '@/lib/repos/ruleSetsRepo';
import {
  ruleSetIssues,
  type Rule,
  type RuleSet,
  type RuleSetCreate,
  type RuleSetUpdate,
} from '@/schemas';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A RULE-SET rule references a rule-set by its `name`, and mihomo aborts the
 * whole config with `not found rule-set: <name>` if the referenced provider
 * declaration is missing. Renaming was previously a metadata-only change with
 * no cascade — so renaming a referenced set silently broke every config that
 * used it. This restores the invariant (mirroring proxyGroupService's
 * cascadeRename): rename-cascade the RULE-SET *rules* across every profile
 * (rule-sets are a shared library), and refuse the rename outright if the old
 * name is baked into any profile's base body as a `rule-set:` key (rewriting
 * arbitrary YAML text there is unsafe — the user must edit those by hand). P0-1.
 */
async function cascadeRuleSetRename(oldName: string, newName: string): Promise<void> {
  if (oldName === newName) return;
  const profiles = await listProfiles();

  // Base-body references (e.g. DNS nameserver-policy `rule-set:foo` keys) can't
  // be auto-rewritten safely → block the rename with an actionable message.
  const bases = await Promise.all(profiles.map((p) => getBase(p.id)));
  const baseRefProfiles = profiles.filter((_, i) =>
    referencedProviderNamesInBaseYaml(bases[i]?.content ?? '').has(oldName),
  );
  if (baseRefProfiles.length > 0) {
    throw ProblemDetailsError.conflict(
      `规则集 "${oldName}" 被 ${baseRefProfiles.length} 个配置文件的 base 正文以 \`rule-set:\` 直接引用,无法自动改名(改动 base 文本有风险)。请先在这些 base 中手动改名后再试。`,
    );
  }

  // Cascade every referencing RULE-SET rule to the new name, per profile.
  const now = nowSeconds();
  const ruleLists = await Promise.all(profiles.map((p) => listRules(p.id)));
  await Promise.all(
    profiles.map(async (p, i) => {
      const toWrite: Rule[] = [];
      for (const r of ruleLists[i]) {
        if (r.type === 'RULE-SET' && r.value === oldName) {
          toWrite.push({ ...r, value: newName, updated_at: now });
        }
      }
      if (toWrite.length > 0) await upsertRules(p.id, toWrite);
    }),
  );
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
    // P0-1: keep referencing rules in sync (or refuse if base body references it).
    await cascadeRuleSetRename(current.name, input.name);
  }
  const next: RuleSet = { ...input, id, updated_at: nowSeconds() };
  assertInvariants(next);
  await upsertRuleSet(next);
  return next;
}

export async function patchRuleSet(
  id: string,
  patch: RuleSetUpdate,
  expectedUpdatedAt?: number, // P2-2
): Promise<RuleSet> {
  const current = await getRuleSet(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  }
  // P2-2: optimistic concurrency. When the caller passes their last-known
  // updated_at (via If-Match), refuse if the record moved since — otherwise two
  // concurrent editors (two tabs / human + AI) silently overwrite each other.
  if (expectedUpdatedAt !== undefined && current.updated_at !== expectedUpdatedAt) {
    throw ProblemDetailsError.preconditionFailed('该资源已被其他人修改,请刷新后重试。');
  }
  if (patch.name && patch.name !== current.name) {
    const dup = await getRuleSetByName(patch.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Rule set name "${patch.name}" already exists.`);
    }
    // P0-1: keep referencing rules in sync (or refuse if base body references it).
    await cascadeRuleSetRename(current.name, patch.name);
  }
  // P1-5: `null` on an optional field clears it (delete the key); `undefined`
  // means "leave unchanged". Anything else overwrites.
  const next: RuleSet = { ...current, id, updated_at: nowSeconds() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete (next as Record<string, unknown>)[k];
    } else if (v !== undefined) {
      (next as Record<string, unknown>)[k] = v;
    }
  }
  assertInvariants(next);
  await upsertRuleSet(next);
  return next;
}

export { listRuleSets, getRuleSet, getRuleSetByName, repoDelete as deleteRuleSet };
