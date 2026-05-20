import { z } from 'zod';
import { RuleSchema } from './rule';

export const AuditOpSchema = z.enum(['rule.create', 'rule.update', 'rule.delete']);

export const AuditEventSchema = z.object({
  id: z.uuid(),
  ts: z.number().int(),
  op: AuditOpSchema,
  actor: z.string().min(1),
  ruleId: z.string().min(1),
  /** Pre-mutation snapshot. Absent for create. */
  before: RuleSchema.optional(),
  /** Post-mutation snapshot. Absent for delete. */
  after: RuleSchema.optional(),
  /** Event id of the undo that reversed this entry, if any. */
  undone_by: z.uuid().optional(),
  /** When this event itself is an undo, points at the original event. */
  undoes: z.uuid().optional(),
});

export type AuditOp = z.infer<typeof AuditOpSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
