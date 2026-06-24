import { z } from 'zod';
import { RuleSchema } from './rule';

/**
 * The audit log supports two kinds of ops:
 *
 *  - First-party rule mutations (the original M1c CRUD path). Op enum values
 *    `rule.create | rule.update | rule.delete`, target.kind='rule'.
 *  - Scenario mutations dispatched through `POST /api/v1/ops`. Op is namespaced
 *    as `${scenarioId}.${action}` (e.g. `chained-proxy.set-dialer`,
 *    `regional-groups.add-node`). Target is whatever the scenario produces.
 *
 * The schema deliberately accepts both via union: legacy `rule.*` ops keep
 * `ruleId` for backward compat with already-recorded events; scenario ops
 * always populate `target` and may also fill `ruleId` for rule-bearing
 * scenarios (e.g. the migrated rule-anchor-append scenario).
 */
export const AuditTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rule'), id: z.string().min(1) }),
  z.object({ kind: z.literal('proxy'), name: z.string().min(1) }),
  z.object({ kind: z.literal('proxy-group'), name: z.string().min(1) }),
  z.object({ kind: z.literal('rule-set'), name: z.string().min(1) }),
  z.object({ kind: z.literal('base'), field: z.string().optional() }),
]);

export const AuditOpSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(v), {
    message: 'op must be dotted segments, e.g. "rule.create" or "chained-proxy.set-dialer"',
  });

export const AuditEventSchema = z.object({
  id: z.uuid(),
  ts: z.number().int(),
  op: AuditOpSchema,
  actor: z.string().min(1),
  /** Legacy/back-compat field for `rule.*` events. Scenario ops use `target` instead. */
  ruleId: z.string().min(1).optional(),
  target: AuditTargetSchema.optional(),
  /** Pre-mutation snapshot. Shape depends on op — typed as unknown so scenarios can carry richer payloads. */
  before: z.unknown().optional(),
  /** Post-mutation snapshot. */
  after: z.unknown().optional(),
  /** Event id of the undo that reversed this entry, if any. */
  undone_by: z.uuid().optional(),
  /** When this event itself is an undo, points at the original event. */
  undoes: z.uuid().optional(),
  /**
   * The profile this mutation targeted (Phase 2: base/rules/proxy-groups are
   * per-profile). Optional for back-compat with pre-Phase-2 events; undo falls
   * back to the `default` profile when absent.
   */
  profileId: z.string().min(1).optional(),
});

/** Convenience type for events known to target a rule (still carry a typed snapshot). */
export const RuleAuditEventSchema = AuditEventSchema.extend({
  before: RuleSchema.optional(),
  after: RuleSchema.optional(),
});

export type AuditOp = z.infer<typeof AuditOpSchema>;
export type AuditTarget = z.infer<typeof AuditTargetSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
