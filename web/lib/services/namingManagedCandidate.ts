/**
 * namingManagedCandidate — the ONE pure managed-candidate builder.
 *
 * UI preview, assistant confirmation preview and apply all derive the
 * managed rename-template candidate from this single side-effect-free
 * builder over the ALIGNED raw OperatorSnapshot (rawOperators.ts):
 *   - every NON-managed raw row is preserved byte-for-byte in identical
 *     order (parked/malformed/primitive rows included);
 *   - an existing managed row (aligned current-valid rename-template —
 *     disabled included) keeps its id AND index and is ENABLED by the new
 *     plan (apply always activates);
 *   - otherwise the row is inserted at the clamped position (default: end)
 *     with the deterministic FIRST FREE id `naming-plan`, `naming-plan-2`,
 *     `naming-plan-3`, … over EVERY raw string id — a raw row already
 *     named `naming-plan` can never collide;
 *   - returns { storage, row, id, index, mode } with mode
 *     'added' | 'replaced' | 'kept'.
 *
 * There is NO reserved literal id and no second candidate maker anywhere:
 * the workspace route preview, save_naming_plan preview and
 * applyNamingPlan all call this builder (namingPreviewService /
 * namingApplyService), so preview and apply are byte-identical by
 * construction.
 */

import { buildOperatorSnapshot, type OperatorSnapshot } from '@/lib/repos/rawOperators';
import type { Operator, StoredOperator } from '@/schemas';

/** The complete policy a managed rename-template row carries. */
export interface NamingManagedPlan {
  template: string;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: Array<{ pattern: string; field: string; value: string }>;
}

export interface ManagedCandidateResult {
  /** The exact next raw operator list (untouched rows byte-for-byte). */
  storage: unknown[];
  /** The managed row (decoded-level shape, enabled). */
  row: Operator;
  /** The allocated/preserved managed-row id. */
  id: string;
  /** The applied raw index. */
  index: number;
  /** 'added' — inserted fresh; 'replaced' — existing row touched/enabled;
   * 'kept' — existing row and identical plan (byte-identical no-op). */
  mode: 'added' | 'replaced' | 'kept';
}

/** The canonical managed candidate id: `naming-plan`, then `naming-plan-2`, … */
export const MANAGED_CANDIDATE_ID_BASE = 'naming-plan';

/** Deterministic first free id over EVERY raw string id. */
function firstFreeId(rows: readonly { id: string }[]): string {
  const taken = new Set<string>();
  for (const row of rows) {
    if (row.id !== '') taken.add(row.id);
  }
  let candidate = MANAGED_CANDIDATE_ID_BASE;
  let attempt = 1;
  while (taken.has(candidate)) {
    attempt += 1;
    candidate = `${MANAGED_CANDIDATE_ID_BASE}-${attempt}`;
  }
  return candidate;
}

/** Row shape — alias table omitted when empty (schema contract). */
function managedRowOf(id: string, plan: NamingManagedPlan): Operator {
  return {
    id,
    kind: 'rename-template',
    template: plan.template,
    tw2cn: plan.tw2cn,
    sourceAliases:
      plan.sourceAliases && Object.keys(plan.sourceAliases).length > 0
        ? plan.sourceAliases
        : undefined,
    recognitionRules: plan.recognitionRules ?? [],
    // apply ALWAYS activates: never carry a disabled flag on the candidate
  } as Operator;
}

/** Structural key-order-insensitive equality (same semantics as the raw
 * materializer) for the 'kept' no-op detection. */
function deepEqualKeyOrderInsensitive(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i += 1) {
      if (!deepEqualKeyOrderInsensitive(aa[i], bb[i])) return false;
    }
    return true;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keysOf = (record: Record<string, unknown>): string[] =>
    Object.keys(record).filter((key) => record[key] !== undefined);
  const ka = keysOf(ra);
  const kb = keysOf(rb);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, key) || rb[key] === undefined) return false;
    if (!deepEqualKeyOrderInsensitive(ra[key], rb[key])) return false;
  }
  return true;
}

/**
 * Complete ONE plan from the submitted fields + the current managed row's
 * policy: template-only edits keep the existing tw2cn/sourceAliases/
 * recognitionRules, while an explicit false/[]/empty value wins (full-plan
 * replacement by the AI workspace). Preview and apply BOTH normalize through
 * this helper so the same draft always produces the same candidate.
 */
/** The prior-policy shape completeNamingPlan merges from. */
export type PriorNamingPolicy = {
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: Array<{ pattern: string; field: string; value: string }>;
};

/**
 * Narrow an aligned snapshot's managed decoded row to its policy fields.
 * The aligned managed row is guaranteed to be a current-valid
 * rename-template at runtime; the union type cannot express that, so this
 * one narrowing helper is the only place the invariant is applied.
 */
export function priorPolicyOf(op: StoredOperator | undefined): PriorNamingPolicy | undefined {
  if (op === undefined || op.kind !== 'rename-template') return undefined;
  return {
    tw2cn: op.tw2cn,
    sourceAliases: op.sourceAliases,
    recognitionRules: op.recognitionRules,
  };
}

export function completeNamingPlan(
  plan: NamingManagedPlan,
  prior: PriorNamingPolicy | undefined,
): NamingManagedPlan {
  const priorAliases =
    prior?.sourceAliases && Object.keys(prior.sourceAliases).length > 0
      ? prior.sourceAliases
      : undefined;
  return {
    template: plan.template,
    // explicit false/empty wins (full-plan replacement); only ABSENT fields
    // fall back to the current row's policy
    tw2cn: plan.tw2cn !== undefined ? plan.tw2cn : prior?.tw2cn,
    sourceAliases:
      plan.sourceAliases !== undefined
        ? Object.keys(plan.sourceAliases).length > 0
          ? plan.sourceAliases
          : undefined
        : priorAliases,
    recognitionRules:
      plan.recognitionRules !== undefined ? plan.recognitionRules : (prior?.recognitionRules ?? []),
  };
}

/**
 * Build the managed candidate over an aligned snapshot.
 *
 * @param snapshot   the aligned raw operator snapshot (buildOperatorSnapshot)
 * @param plan       the complete policy to apply
 * @param options    optional clamped insertion position (default: end)
 */
export function buildManagedCandidate(
  snapshot: OperatorSnapshot,
  plan: NamingManagedPlan,
  options?: { position?: number },
): ManagedCandidateResult {
  const rawRows = snapshot.raw;
  const managed = snapshot.managed;
  const next = [...rawRows];
  if (managed !== undefined) {
    // REPLACE IN PLACE: id + index preserved, row enabled with the new plan
    const row = managedRowOf(managed.id, plan);
    const decodedRow = snapshot.rows[managed.index].decoded;
    const same =
      decodedRow !== undefined &&
      deepEqualKeyOrderInsensitive(decodedRow, row) &&
      decodedRow.disabled !== true;
    if (same) {
      // byte-identical no-op: the RAW row (unknown persisted fields
      // included) survives untouched — the plan row is only the projection
      return { storage: next, row, id: managed.id, index: managed.index, mode: 'kept' };
    }
    next[managed.index] = row;
    return { storage: next, row, id: managed.id, index: managed.index, mode: 'replaced' };
  }
  // INSERT a fresh row at the clamped position with the first free id
  const insertAt = Math.max(0, Math.min(options?.position ?? next.length, next.length));
  const id = firstFreeId(snapshot.rows.map((entry) => ({ id: entry.id })));
  const row = managedRowOf(id, plan);
  next.splice(insertAt, 0, row);
  return { storage: next, row, id, index: insertAt, mode: 'added' };
}

/** Convenience: build the snapshot from a parsed entity record. */
export function buildManagedCandidateForEntity<T extends { operators?: unknown }>(
  entity: T,
  plan: NamingManagedPlan,
  options?: { position?: number },
): ManagedCandidateResult {
  return buildManagedCandidate(buildOperatorSnapshot(entity), plan, options);
}
