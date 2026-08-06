/**
 * OperatorMutationPolicy — the SINGLE authority that governs WHO may change
 * a persisted operator pipeline and WHAT the exact storage list must be.
 *
 * Two authorities:
 *   - `generic` — subscription/collection create/replace/patch and the
 *     generic operator actions (add/update/delete/reorder). May change
 *     non-name rows freely (edit, kind-change, insert, delete, reorder),
 *     may NOT create, delete, logically edit, or move the managed
 *     rename-template row across ANY surviving existing operator. The
 *     LOGICAL managed row is the FIRST raw+decoded current-valid
 *     rename-template row (same non-empty id, no own compatibility_issue);
 *     runtime-invalid, duplicate and parked rename-shaped rows are
 *     non-managed and keep repair/removal semantics. Inserting or
 *     deleting a non-name row BEFORE the managed row may shift its numeric
 *     index — that is a numeric shift, not a logical move, and is allowed.
 *     The EXACT SET of surviving existing identities before the managed row
 *     must be equal in current and candidate (every surviving row keeps its
 *     before/after side): same-side reorder passes, one-way and simultaneous
 *     two-way crossing fail. JSON object-key order is never product state.
 *     The storage list is rebuilt so untouched rows are persisted from their
 *     RAW bytes, an explicitly edited same-kind non-name row merges
 *     validated known fields while retaining unknown fields, and a
 *     deliberate kind change replaces the row. A current ID with multiplicity
 *     > 1 that the candidate retains is ambiguous (an ID-only handle cannot
 *     identify two rows) and fails with one bounded ambiguity error.
 *   - `naming` — the profile-bound naming apply/rollback service ONLY. May
 *     replace/add/remove the logical managed row, must strip ONLY that row
 *     from both sides and require every remaining raw row structurally equal
 *     in IDENTICAL order, must keep an existing managed row at the same
 *     index, and reports whether a naming mutation occurred.
 *
 * This module replaces the old namingPipelineGuard: it owns the same bounded
 * dedicated-gate error (NAMING_ROW_GATE_ERROR) but with corrected semantics
 * (exact survivor-side sets, key-order-insensitive equality, raw-row reuse
 * for storage) so a generic request can never rewrite or narrow the naming
 * row nor re-serialize the decoded view over raw bytes.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { hasOwnCompatibilityIssue, StoredOperatorListSchema } from '@/schemas/operator';
import {
  buildOperatorSnapshot,
  deepEqualKeyOrderInsensitive,
  mergeEditedOperatorRow,
  type OperatorSnapshot,
} from '@/lib/repos/rawOperators';

/** One bounded dedicated-gate error for every generic naming-row violation. */
export const NAMING_ROW_GATE_ERROR =
  '名称统一（rename-template）算子只能在「智能命名」页面修改，不能通过通用节点处理保存。';

/** One bounded ambiguity error for a retained duplicate operator ID — an
 * ID-only handle cannot identify two rows. */
export const AMBIGUOUS_OPERATOR_ID_ERROR =
  '算子 id 重复：无法安全定位该步骤，请先在「节点处理」页面处理。';

export type OperatorMutationAuthority = 'generic' | 'naming';

export interface OperatorMutationResult {
  /** The EXACT raw operator list to persist (raw bytes for untouched rows). */
  storage: unknown[];
  /** True when the managed naming row(s) changed (naming authority only;
   * generic writes that would change a naming row fail before returning). */
  namingMutated: boolean;
}

/** isRecord guard — operator rows may be null/primitives; NEVER do property
 * access on non-records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idOf(row: unknown): string {
  return isRecord(row) && typeof row.id === 'string' ? row.id : '';
}

function kindOf(row: unknown): unknown {
  return isRecord(row) ? row.kind : undefined;
}

function throwNamingGate(): never {
  throw ProblemDetailsError.badRequest(NAMING_ROW_GATE_ERROR);
}

/**
 * The naming-row invariant for GENERIC writes (throw-only; used by previews
 * and by the materializer below):
 *   1. no create/delete of the LOGICAL managed row (the first aligned
 *      current-valid rename-template — same non-empty id, no own
 *      compatibility_issue; runtime-invalid/duplicate/parked rename-shaped
 *      rows are non-managed and stay repairable/removable);
 *   2. the managed candidate must retain its ID and be structurally equal
 *      under unordered object keys and ordered arrays;
 *   3. the EXACT SET of surviving existing row identities before the managed
 *      row must be equal in current and candidate — every surviving row
 *      retains its before/after side. New/deleted rows are not survivors, so
 *      index shifts from insertion/deletion pass; same-side reorder passes;
 *      one-way and SIMULTANEOUS two-way crossing fail;
 *   4. a current ID with multiplicity > 1 that the candidate RETAINS is
 *      ambiguous (an ID-only handle cannot identify two rows) → one bounded
 *      ambiguity error; omitting it deliberately deletes all such
 *      non-managed rows and passes.
 */
/** The candidate's logical managed row — the first row whose raw shape is a
 * plain rename-template with non-empty id AND whose aligned decoded view
 * (StoredOperatorListSchema) is a plain current-schema rename-template with
 * the same id and no own compatibility_issue (Object.hasOwn — inherited
 * values/getters never satisfy). Candidates are schema-validated at
 * the API boundary; this mirrors the snapshot classifier for defense. */
function candidateManagedNamingRow(
  candidate: readonly unknown[],
): { index: number; id: string; row: unknown } | undefined {
  const decoded = StoredOperatorListSchema.parse(candidate);
  for (let i = 0; i < candidate.length; i += 1) {
    const rawRow = candidate[i];
    const decodedRow = decoded[i];
    if (
      isRecord(rawRow) &&
      rawRow.kind === 'rename-template' &&
      typeof rawRow.id === 'string' &&
      rawRow.id !== '' &&
      decodedRow !== undefined &&
      !hasOwnCompatibilityIssue(decodedRow) &&
      decodedRow.kind === 'rename-template' &&
      decodedRow.id === rawRow.id
    ) {
      return { index: i, id: rawRow.id, row: rawRow };
    }
  }
  return undefined;
}

export function assertGenericNamingRowsInvariant(
  snapshot: OperatorSnapshot,
  candidate: readonly unknown[],
): void {
  const currentManaged = snapshot.managed;
  const candidateManaged = candidateManagedNamingRow(candidate);
  if (currentManaged === undefined && candidateManaged !== undefined) throwNamingGate();
  if (currentManaged !== undefined && candidateManaged === undefined) throwNamingGate();
  // Candidate duplicate IDs are schema-rejected at the API boundary — the
  // policy rejects them identically (defense in depth: an ID-only handle
  // cannot identify two rows).
  const candidateIdCounts = new Map<string, number>();
  for (const row of candidate) {
    const id = idOf(row);
    if (id !== '') candidateIdCounts.set(id, (candidateIdCounts.get(id) ?? 0) + 1);
  }
  for (const count of candidateIdCounts.values()) {
    if (count > 1) throwNamingGate();
  }
  // Retained ambiguous duplicate current IDs → bounded ambiguity error.
  const currentIdCounts = new Map<string, number>();
  for (const row of snapshot.decoded) {
    const id = idOf(row);
    if (id !== '') currentIdCounts.set(id, (currentIdCounts.get(id) ?? 0) + 1);
  }
  const candidateIds = new Set<string>();
  for (const row of candidate) {
    const id = idOf(row);
    if (id !== '') candidateIds.add(id);
  }
  for (const [id, count] of currentIdCounts) {
    if (count > 1 && candidateIds.has(id)) {
      throw ProblemDetailsError.badRequest(AMBIGUOUS_OPERATOR_ID_ERROR);
    }
  }
  if (currentManaged !== undefined && candidateManaged !== undefined) {
    if (currentManaged.id !== candidateManaged.id) throwNamingGate();
    if (
      !deepEqualKeyOrderInsensitive(
        snapshot.rows[currentManaged.index].decoded,
        candidate[candidateManaged.index],
      )
    ) {
      throwNamingGate(); // logical touch (template/rule/alias/disabled/unknown field)
    }
    // EXACT survivor-side sets: every identity present in BOTH lists before
    // the managed row must be the same set on both sides.
    const survivors = new Set<string>();
    for (const id of currentIdCounts.keys()) {
      if (candidateIds.has(id)) survivors.add(id);
    }
    const beforeCurrent = new Set<string>();
    for (let i = 0; i < currentManaged.index; i += 1) {
      const id = idOf(snapshot.decoded[i]);
      if (survivors.has(id)) beforeCurrent.add(id);
    }
    const beforeCandidate = new Set<string>();
    for (let i = 0; i < candidateManaged.index; i += 1) {
      const id = idOf(candidate[i]);
      if (survivors.has(id)) beforeCandidate.add(id);
    }
    if (beforeCurrent.size !== beforeCandidate.size) throwNamingGate();
    for (const id of beforeCurrent) {
      if (!beforeCandidate.has(id)) throwNamingGate();
    }
  }
}

/**
 * Build the exact storage list for a GENERIC write (after the invariant
 * passed): untouched rows are persisted from their raw bytes; an explicitly
 * edited same-kind non-name row merges validated known fields while
 * retaining unknown fields; a deliberate kind change (or a brand-new row)
 * is persisted as the candidate row; rows absent from the candidate are
 * deleted.
 */
function buildGenericStorage(snapshot: OperatorSnapshot, candidate: readonly unknown[]): unknown[] {
  const currentById = new Map<string, number>();
  snapshot.rows.forEach((row) => {
    // First-wins is safe here: ambiguous retained ids were rejected by the
    // invariant, so every matched id has multiplicity exactly one.
    if (row.id !== '' && !currentById.has(row.id)) currentById.set(row.id, row.index);
  });
  const out: unknown[] = [];
  for (const candRow of candidate) {
    const entry = currentById.get(idOf(candRow));
    if (entry === undefined) {
      out.push(candRow); // new row
      continue;
    }
    if (deepEqualKeyOrderInsensitive(snapshot.rows[entry].decoded, candRow)) {
      out.push(snapshot.rows[entry].raw); // untouched → raw bytes (unknown fields survive)
      continue;
    }
    const currentKind = kindOf(snapshot.rows[entry].decoded);
    const candKind = kindOf(candRow);
    if (currentKind === candKind && candKind !== 'rename-template') {
      out.push(mergeEditedOperatorRow(snapshot.rows[entry].raw, candRow)); // same-kind edit
      continue;
    }
    out.push(candRow); // deliberate kind change / replacement
  }
  return out;
}

/**
 * The naming authority: strip ONLY the logical managed row from both sides,
 * require every remaining raw row structurally equal in IDENTICAL order,
 * require an existing managed row to stay at the same index, then return the
 * candidate as the storage list and report whether the naming row(s)
 * changed. Naming apply/rollback alone may replace/add/remove the managed
 * row; parked/malformed/null/primitive rows are never rejected and every
 * other value materializes from snapshot.raw.
 */
function validateNamingMutation(
  snapshot: OperatorSnapshot,
  candidate: readonly unknown[],
): OperatorMutationResult {
  const currentManaged = snapshot.managed;
  const candidateManaged = candidateManagedNamingRow(candidate);
  const currentRemaining = snapshot.raw.filter(
    (_row, i) => currentManaged === undefined || i !== currentManaged.index,
  );
  const candidateRemaining = candidate.filter(
    (_row, i) => candidateManaged === undefined || i !== candidateManaged.index,
  );
  if (currentRemaining.length !== candidateRemaining.length) {
    throw new Error('operatorMutationPolicy: naming mutation must preserve every non-naming row');
  }
  for (let i = 0; i < currentRemaining.length; i += 1) {
    if (!deepEqualKeyOrderInsensitive(currentRemaining[i], candidateRemaining[i])) {
      throw new Error('operatorMutationPolicy: naming mutation must preserve every non-naming row');
    }
  }
  // An existing managed row must stay at the same index (apply replaces in
  // place; rollback restores at the recorded position).
  if (
    currentManaged !== undefined &&
    candidateManaged !== undefined &&
    currentManaged.index !== candidateManaged.index
  ) {
    throw new Error('operatorMutationPolicy: the managed row must keep its index');
  }
  const namingChanged =
    currentManaged === undefined
      ? candidateManaged !== undefined
      : candidateManaged === undefined
        ? true
        : currentManaged.id !== candidateManaged.id ||
          !deepEqualKeyOrderInsensitive(currentManaged.raw, candidate[candidateManaged.index]);
  return { storage: [...candidate], namingMutated: namingChanged };
}

/**
 * The single mutation boundary: run the current-vs-candidate invariant for
 * the authority and return the exact raw storage list. `candidate` is the
 * decoded-level management view (schema-validated Operator[] for generic
 * writes, or the naming service's raw-built list for naming writes).
 */
export function applyOperatorMutation(
  snapshot: OperatorSnapshot,
  candidate: readonly unknown[],
  authority: OperatorMutationAuthority,
): OperatorMutationResult {
  if (authority === 'naming') return validateNamingMutation(snapshot, candidate);
  assertGenericNamingRowsInvariant(snapshot, candidate);
  return { storage: buildGenericStorage(snapshot, candidate), namingMutated: false };
}

/** Re-exported convenience: build the snapshot from a parsed record. */
export { buildOperatorSnapshot };
export type { OperatorSnapshot } from '@/lib/repos/rawOperators';
