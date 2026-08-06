/**
 * Persisted prior-plan storage for the 智能命名 workspace.
 *
 * Real rollback (not draft reset): when a managed-naming plan is APPLIED, the
 * COMPLETE prior state is stored here — including "absent" (no managed naming
 * existed, `hadManaged: false`) so the FIRST apply can be rolled back by
 * removing the rename operator again. The LOGICAL managed row is the FIRST
 * raw+decoded current-valid rename-template row (same non-empty id, no own
 * compatibility_issue); apply/rollback touch ONLY that row. Its prior state
 * is stored as the FULL raw row (rawOp — byte-exact: id/disabled/legacy
 * preset+components/passthrough and opaque fields round-trip verbatim), with
 * the decoded plan (template + every policy field) as the fallback for
 * history entries written before rawOp existed. Runtime-invalid, duplicate
 * and parked rename-shaped rows are NON-managed: apply/rollback never touch
 * them and their raw bytes survive byte-for-byte.
 *
 * Ordering contract (C14): config + config:version + history set/clear move
 * in ONE atomic Lua transaction (namingCasRepo.CAS_ENTITY_WITH_HISTORY) whose
 * prevalidation runs before ANY mutation — a failed preflight/CAS/history
 * transition therefore never persists history, never bumps the version, and
 * never leaves a partial config. This module's standalone set/clear helpers
 * exist for migration/debugging only; every apply/rollback path goes through
 * the atomic CAS.
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { z } from '@/lib/openapi/zod';

/**
 * The complete prior naming state. `hadManaged` distinguishes "no managed
 * naming existed before the apply" (rollback = remove the operator) from
 * "a managed plan existed" (rollback = restore its exact fields).
 */
export const NamingHistoryPlanSchema = z.object({
  hadManaged: z.boolean(),
  template: z.string().min(1).max(512).optional(),
  tw2cn: z.boolean().optional(),
  sourceAliases: z.record(z.string(), z.string()).optional(),
  recognitionRules: z
    .array(z.object({ pattern: z.string(), field: z.string(), value: z.string() }))
    .optional(),
  /** Exact op id of the PRIOR rename-template row (restored on rollback). */
  opId: z.string().optional(),
  /** Exact list position of the PRIOR row (restored on rollback). */
  position: z.number().int().nonnegative().optional(),
  /** A pre-existing DISABLED rename-template must be restored disabled. */
  disabled: z.boolean().optional(),
  /**
   * The FULL raw prior operator row (byte-exact rollback). Kept as
   * z.unknown() so NO field is narrowed away — preset/components, passthrough
   * future fields and opaque fields round-trip verbatim.
   */
  rawOp: z.unknown().optional(),
});

export type NamingHistoryPlan = z.infer<typeof NamingHistoryPlanSchema>;

export async function getNamingHistory(
  type: 'subscription' | 'collection',
  id: string,
): Promise<NamingHistoryPlan | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.namingHistory, `${type}:${id}`);
  if (raw === null || raw === undefined) return null;
  const parsed = NamingHistoryPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function setNamingHistory(
  type: 'subscription' | 'collection',
  id: string,
  plan: NamingHistoryPlan,
): Promise<void> {
  await getRedis().hset(REDIS_KEYS.namingHistory, { [`${type}:${id}`]: plan });
}

export async function clearNamingHistory(
  type: 'subscription' | 'collection',
  id: string,
): Promise<void> {
  await getRedis().hdel(REDIS_KEYS.namingHistory, `${type}:${id}`);
}
