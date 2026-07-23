import { ProblemDetailsError } from '@/lib/http/problem';
import {
  commitRuleSetChange,
  deleteRuleSet as repoDelete,
  getRuleSet,
  getRuleSetByName,
  listRuleSets,
  type RuleSetCommit,
} from '@/lib/repos/ruleSetsRepo';
import {
  findReferencingProfiles,
  preflightRuleSetChange,
  type ReferencingProfile,
} from '@/lib/services/ruleSetGate';
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
 * used it. This computes the cascade (rename the RULE-SET *rules* across every
 * referencing profile) and refuses outright if the old name is baked into a
 * profile's base body as a `rule-set:` key (rewriting arbitrary YAML text there
 * is unsafe — the user must edit those by hand). P0-1.
 *
 * The cascade is only *computed* here; it is applied inside the same
 * config:version CAS as the rule-set write, after every referencing profile has
 * been preflighted against the post-rename candidate.
 */
function planRenameCascade(
  affected: readonly ReferencingProfile[],
  oldName: string,
  newName: string,
): Map<string, Rule[]> {
  const baseRefProfiles = affected.filter((a) => a.baseReferences);
  if (baseRefProfiles.length > 0) {
    throw ProblemDetailsError.conflict(
      `规则集 "${oldName}" 被 ${baseRefProfiles.length} 个配置文件的 base 正文以 \`rule-set:\` 直接引用,无法自动改名(改动 base 文本有风险)。请先在这些 base 中手动改名后再试。`,
    );
  }
  const now = nowSeconds();
  const out = new Map<string, Rule[]>();
  for (const { profile, rules } of affected) {
    const renamed = rules
      .filter((r) => r.value === oldName)
      .map((r) => ({ ...r, value: newName, updated_at: now }));
    if (renamed.length > 0) out.set(profile.id, renamed);
  }
  return out;
}

/**
 * The single write gate for the shared rule-set library.
 *
 * Every mutation — create / replace / patch / delete, and the scenario inverses
 * that undo them — funnels through here: build the candidate library, preflight
 * every referencing profile against it (which transitively validates each of
 * those profiles' devices), then commit under the version the preflight saw.
 */
async function commitRuleSetUnderGate(options: {
  /** Names whose consumers must be validated (old + new on a rename). */
  affectedNames: readonly string[];
  /** Derive the candidate library from the bracketed current one. */
  candidate: (current: RuleSet[]) => RuleSet[];
  /** Rename cascade, if any. */
  cascade?: (affected: readonly ReferencingProfile[]) => Map<string, Rule[]>;
  /** What to persist. */
  commit: RuleSetCommit;
}): Promise<void> {
  const affected = await findReferencingProfiles(options.affectedNames);
  const cascadeWrites = options.cascade?.(affected);

  const version = await preflightRuleSetChange({
    candidateSets: options.candidate,
    cascadeWrites,
    affected,
  });

  const committed = await commitRuleSetChange(
    {
      ...options.commit,
      ...(cascadeWrites
        ? {
            ruleWrites: [...cascadeWrites.entries()].map(([profileId, rules]) => ({
              profileId,
              rules,
            })),
          }
        : {}),
    },
    version,
  );
  if (!committed.ok) {
    throw ProblemDetailsError.preconditionFailed(
      '配置在保存前校验期间被其他写入修改,请刷新后重试。',
    );
  }
}

/** Throw a 422 if the (possibly merged) record violates a cross-field invariant. */
function assertInvariants(set: Pick<RuleSet, 'source' | 'format' | 'content' | 'url'>): void {
  const issues = ruleSetIssues(set);
  if (issues.length > 0) throw ProblemDetailsError.unprocessable(issues[0].message);
}

export function generateRuleSetId(): string {
  return crypto.randomUUID();
}

/** 候选库 = 当前库替换/追加这一条（meta 级，与 listRuleSets 的形状一致）。 */
function withSet(current: RuleSet[], next: RuleSet): RuleSet[] {
  const out = current.filter((s) => s.id !== next.id);
  out.push({ ...next, content: '' });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createRuleSet(input: RuleSetCreate): Promise<RuleSet> {
  const dup = await getRuleSetByName(input.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`Rule set name "${input.name}" already exists.`);
  }
  const set: RuleSet = { ...input, id: generateRuleSetId(), updated_at: nowSeconds() };
  // 注意:新建刻意不跑 assertInvariants —— 与改动前的行为保持一致(允许先建壳、
  // 之后再补内容);真正会进渲染的是被引用之后，那时 patch/replace 会校验。
  // 新建的名字还没有任何引用者 → affected 为空 → 不改变任何渲染产物，
  // 但仍走同一条 CAS 通道，避免与并发的库改动交错。
  await commitRuleSetUnderGate({
    affectedNames: [set.name],
    candidate: (current) => withSet(current, set),
    commit: { write: set },
  });
  return set;
}

export async function replaceRuleSet(id: string, input: RuleSetCreate): Promise<RuleSet> {
  const current = await getRuleSet(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  }
  const renaming = input.name !== current.name;
  if (renaming) {
    const dup = await getRuleSetByName(input.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Rule set name "${input.name}" already exists.`);
    }
  }
  const next: RuleSet = { ...input, id, updated_at: nowSeconds() };
  assertInvariants(next);
  await commitRuleSetUnderGate({
    affectedNames: renaming ? [current.name, input.name] : [current.name],
    candidate: (sets) => withSet(sets, next),
    ...(renaming
      ? { cascade: (affected) => planRenameCascade(affected, current.name, input.name) }
      : {}),
    commit: { write: next },
  });
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
  const renaming = Boolean(patch.name && patch.name !== current.name);
  if (renaming) {
    const dup = await getRuleSetByName(patch.name!);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`Rule set name "${patch.name}" already exists.`);
    }
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
  await commitRuleSetUnderGate({
    affectedNames: renaming ? [current.name, next.name] : [current.name],
    candidate: (sets) => withSet(sets, next),
    ...(renaming
      ? { cascade: (affected) => planRenameCascade(affected, current.name, next.name) }
      : {}),
    commit: { write: next },
  });
  return next;
}

/**
 * 删除。调用方（rule-provider 场景）已经先拒绝了「仍被引用」的情况，所以走到这里时
 * 引用者集合应当为空；仍照常过闸口 —— 万一判定漏了什么，preflight 会兜住，而不是
 * 让一条悬空引用直接落库。
 */
export async function deleteRuleSetChecked(id: string): Promise<boolean> {
  const current = await getRuleSet(id);
  if (!current) return false;
  await commitRuleSetUnderGate({
    affectedNames: [current.name],
    candidate: (sets) => sets.filter((s) => s.id !== id),
    commit: { deleteId: id },
  });
  return true;
}

/**
 * 恢复一份规则集快照（撤销用）。与正向写入走同一条闸口 —— 撤销不是特权路径：
 * 把库改回旧状态，对**当下**引用它的配置文件而言同样是一次共享资源改写。
 *
 * `previous` 是恢复前的现状（null = 该记录当前不存在，属于「撤销删除」）。
 * 恢复若涉及改名（快照名与现状名不同），级联照常计算。
 */
export async function restoreRuleSet(
  snapshot: RuleSet,
  previous: RuleSet | null,
): Promise<RuleSet> {
  assertInvariants(snapshot);
  const renaming = previous !== null && previous.name !== snapshot.name;
  await commitRuleSetUnderGate({
    affectedNames: previous ? [previous.name, snapshot.name] : [snapshot.name],
    candidate: (sets) => withSet(sets, snapshot),
    ...(renaming
      ? { cascade: (affected) => planRenameCascade(affected, previous.name, snapshot.name) }
      : {}),
    commit: { write: snapshot },
  });
  return snapshot;
}

export { listRuleSets, getRuleSet, getRuleSetByName, repoDelete as deleteRuleSetUnchecked };
