/**
 * `rule-provider` — CRUD over the platform-managed rule-set library, with
 * audit + undo, mirroring `rule-anchor-append` (rules) but for rule-sets.
 *
 * Storage is the `rule-sets` Redis hash (via ruleSetService/Repo, imported
 * directly — same shortcut the rule + config-section scenarios take). The
 * library is the source of truth; the renderer emits a `rule-providers:`
 * declaration only for entries an enabled RULE-SET rule references.
 *
 * Ops + inverses:
 *   create  → delete (remove the created set)
 *   replace → update (restore the prior snapshot)
 *   patch   → update (restore the prior snapshot)
 *   delete  → create (re-upsert the prior snapshot)
 *
 * Concurrency: rule-set.updated_at acts as the optimistic version; inverse
 * handlers refuse with 409 if the live record moved past the snapshot.
 */

import { z } from 'zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import { referencedProviderNamesInBaseYaml } from '@/lib/engine/renderer';
import { getBase } from '@/lib/repos/baseRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { getRuleSetByName } from '@/lib/repos/ruleSetsRepo';
import {
  createRuleSet,
  deleteRuleSetChecked,
  getRuleSet,
  patchRuleSet,
  replaceRuleSet,
  restoreRuleSet,
} from '@/lib/services/ruleSetService';
import { RuleSetCreateSchema, RuleSetUpdateSchema, type RuleSet } from '@/schemas';
import type { InverseHandler, OpHandler, Scenario } from '../_shared/types';

/* ─── Op payload schemas ────────────────────────────────────────────── */

const CreatePayloadSchema = RuleSetCreateSchema;
const ReplacePayloadSchema = z.object({ id: z.uuid(), set: RuleSetCreateSchema });
// P2-2: expectedUpdatedAt threads the route's If-Match version down to
// patchRuleSet for the optimistic-concurrency check.
const PatchPayloadSchema = z.object({
  id: z.uuid(),
  patch: RuleSetUpdateSchema,
  expectedUpdatedAt: z.number().optional(),
});
const DeletePayloadSchema = z.object({ id: z.uuid() });

/* ─── Handlers ──────────────────────────────────────────────────────── */

const create: OpHandler = async (_ctx, raw) => {
  const input = CreatePayloadSchema.parse(raw);
  const set = await createRuleSet(input);
  return {
    data: set,
    events: [{ action: 'create', target: { kind: 'rule-set', name: set.name }, after: set }],
  };
};

const replace: OpHandler = async (_ctx, raw) => {
  const { id, set: body } = ReplacePayloadSchema.parse(raw);
  const before = await getRuleSet(id);
  if (!before) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  const after = await replaceRuleSet(id, body);
  return {
    data: after,
    events: [{ action: 'update', target: { kind: 'rule-set', name: after.name }, before, after }],
  };
};

const patch: OpHandler = async (_ctx, raw) => {
  const { id, patch: body, expectedUpdatedAt } = PatchPayloadSchema.parse(raw);
  const before = await getRuleSet(id);
  if (!before) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  const after = await patchRuleSet(id, body, expectedUpdatedAt); // P2-2
  return {
    data: after,
    events: [{ action: 'update', target: { kind: 'rule-set', name: after.name }, before, after }],
  };
};

const del: OpHandler = async (_ctx, raw) => {
  const { id } = DeletePayloadSchema.parse(raw);
  const before = await getRuleSet(id);
  if (!before) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  // Don't orphan a reference: refuse while any RULE-SET rule still points
  // here. Rule-sets are a SHARED library, so scan every profile's rules.
  const profiles = await listProfiles();
  const ruleLists = await Promise.all(profiles.map((p) => listRules(p.id)));
  const refs = ruleLists.flat().filter((r) => r.type === 'RULE-SET' && r.value === before.name);
  if (refs.length > 0) {
    throw ProblemDetailsError.conflict(
      `规则集 "${before.name}" 仍被 ${refs.length} 条 RULE-SET 规则引用，无法删除；请先修改或删除这些规则。`,
    );
  }
  // P0-1: also refuse while any profile's base body references it via a
  // `rule-set:` key (e.g. DNS nameserver-policy) — deleting would leave that
  // reference dangling and mihomo would abort at load.
  const bases = await Promise.all(profiles.map((p) => getBase(p.id)));
  const baseRefCount = bases.filter((b) =>
    referencedProviderNamesInBaseYaml(b?.content ?? '').has(before.name),
  ).length;
  if (baseRefCount > 0) {
    throw ProblemDetailsError.conflict(
      `规则集 "${before.name}" 仍被 ${baseRefCount} 个配置文件的 base 正文以 \`rule-set:\` 引用，无法删除；请先在这些 base 中移除引用。`,
    );
  }
  const removed = await deleteRuleSetChecked(id);
  if (!removed) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  return {
    data: null,
    events: [{ action: 'delete', target: { kind: 'rule-set', name: before.name }, before }],
  };
};

/* ─── Inverses ──────────────────────────────────────────────────────── */

function snapshotId(event: { after?: unknown; before?: unknown }): {
  before?: RuleSet;
  after?: RuleSet;
} {
  return { before: event.before as RuleSet | undefined, after: event.after as RuleSet | undefined };
}

const inverseCreate: InverseHandler = async (_ctx, event) => {
  const { after } = snapshotId(event);
  if (!after) throw ProblemDetailsError.unprocessable('Event missing after-state.');
  const current = await getRuleSet(after.id);
  if (!current) {
    throw ProblemDetailsError.conflict(`Rule set ${after.id} no longer exists; nothing to undo.`);
  }
  if (current.updated_at !== after.updated_at) {
    throw ProblemDetailsError.conflict(`Rule set ${after.id} was modified after this event.`);
  }
  // 撤销同样过闸口:把一条规则集删掉,对引用它的配置文件而言与正向删除一样危险。
  await deleteRuleSetChecked(after.id);
  return {
    data: null,
    events: [
      { action: 'delete', target: { kind: 'rule-set', name: current.name }, before: current },
    ],
  };
};

const inverseUpdate: InverseHandler = async (_ctx, event) => {
  const { before, after } = snapshotId(event);
  if (!before || !after)
    throw ProblemDetailsError.unprocessable('Event missing before/after-state.');
  const current = await getRuleSet(after.id);
  if (!current) {
    throw ProblemDetailsError.conflict(`Rule set ${after.id} no longer exists; nothing to revert.`);
  }
  if (current.updated_at !== after.updated_at) {
    throw ProblemDetailsError.conflict(`Rule set ${after.id} was modified after this event.`);
  }
  const reverted: RuleSet = { ...before, updated_at: Math.floor(Date.now() / 1000) };
  await restoreRuleSet(reverted, current);
  return {
    data: reverted,
    events: [
      {
        action: 'update',
        target: { kind: 'rule-set', name: reverted.name },
        before: current,
        after: reverted,
      },
    ],
  };
};

const inverseDelete: InverseHandler = async (_ctx, event) => {
  const { before } = snapshotId(event);
  if (!before) throw ProblemDetailsError.unprocessable('Event missing before-state.');
  if (await getRuleSet(before.id)) {
    throw ProblemDetailsError.conflict(`Rule set ${before.id} already exists; nothing to restore.`);
  }
  const dup = await getRuleSetByName(before.name);
  if (dup && dup.id !== before.id) {
    throw ProblemDetailsError.conflict(`Rule set name "${before.name}" is taken; cannot restore.`);
  }
  const restored: RuleSet = { ...before, updated_at: Math.floor(Date.now() / 1000) };
  await restoreRuleSet(restored, null);
  return {
    data: restored,
    events: [
      { action: 'create', target: { kind: 'rule-set', name: restored.name }, after: restored },
    ],
  };
};

/* ─── Scenario export ───────────────────────────────────────────────── */

export const ruleProviderScenario: Scenario = {
  descriptor: {
    id: 'rule-provider',
    title: '规则集',
    description: '管理规则集库（本地托管 / 外部 URL）；被规则引用的会注入到 rule-providers。',
  },
  ops: { create, replace, patch, delete: del },
  inverses: { create: inverseCreate, update: inverseUpdate, delete: inverseDelete },
};
