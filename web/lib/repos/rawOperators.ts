/**
 * Lossless raw stored-operator preservation.
 *
 * The per-item stored decode (StoredOperatorListSchema) parks unknown/malformed
 * rows into synthetic diagnostics so clients never see raw bytes — but if a
 * write path re-serialized the DECODED entity, those raw future-operator bytes
 * would be destroyed. This module keeps the raw persisted `operators` array
 * attached to the parsed record on an ENUMERABLE Symbol: object spreads carry
 * it through service-level merges, while JSON serialization (Redis, API
 * responses, logs) always ignores symbol keys.
 *
 * The repo write primitives call {@link restoreRawOperators}: when the record's
 * operators are byte-equivalent to the deterministic decode of the raw array
 * (i.e. the operators field was NOT explicitly edited), the raw bytes are
 * restored before persistence — recordSubscriptionSync / recordSubscriptionError
 * / refresh status writes / ordinary non-operator patches / cosmetic collection
 * patches therefore never touch unknown/malformed rows. An explicit current
 * operator save (which replaces the array with new valid Operators) produces a
 * different array and wins as-is.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import {
  STORED_OPERATOR_DUPLICATE_ISSUE,
  hasOwnCompatibilityIssue,
  isParkedOperator,
  StoredOperatorListSchema,
  type StoredOperator,
} from '@/schemas/operator';

/** Enumerable on purpose: spreads carry it; JSON.stringify ignores symbols. */
export const RAW_OPERATORS: unique symbol = Symbol('raw-stored-operators');

export type WithRawOperators<T> = T & { [RAW_OPERATORS]?: unknown };

/** Attach the raw persisted `operators` value to a freshly parsed record. */
export function attachRawOperators<T extends { operators?: unknown }>(
  record: T,
  rawOperators: unknown,
): WithRawOperators<T> {
  const out = { ...record };
  Object.defineProperty(out, RAW_OPERATORS, {
    value: rawOperators,
    enumerable: true,
    configurable: true,
  });
  return out as WithRawOperators<T>;
}

/**
 * Restore the raw operators when the current array is exactly the deterministic
 * decode of the raw bytes (untouched operators). Never throws: raw is arbitrary
 * JSON, and the transform accepts unknown items.
 */
export function restoreRawOperators<T extends { operators?: unknown }>(record: T): T {
  const raw = (record as WithRawOperators<T>)[RAW_OPERATORS];
  if (raw === undefined) return record;
  let decoded: StoredOperator[];
  try {
    decoded = StoredOperatorListSchema.parse(raw);
  } catch {
    return record;
  }
  const current = (record.operators ?? []) as unknown;
  if (JSON.stringify(decoded) !== JSON.stringify(current)) return record;
  return { ...record, operators: raw } as T;
}

/* ─── Explicit snapshot / materializer API (round-1 Architecture A; round-3
 * safe managed-row table) ──────────────────────────────────────────────
 *
 * The mutation policy needs BOTH views of a persisted pipeline at once:
 *   - `raw`     — the exact stored bytes (unknown/malformed rows included);
 *   - `decoded` — the deterministic safe management/execution view
 *                 (StoredOperatorListSchema: parked placeholders replace
 *                 undecodable rows, legacy rename-templates are projected to
 *                 the template DSL).
 *
 * Round-3: the snapshot is an IMMUTABLE one-entry-per-raw-index table. Each
 * entry carries index, raw, decoded, classification and id, and the LOGICAL
 * MANAGED rename row is derived from the ALIGNED raw+decoded pair — never
 * from raw kind text alone. A malformed/unknown/runtime-invalid raw row whose
 * kind merely resembles 'rename-template' does not consume the managed slot;
 * only the FIRST aligned current-valid rename-template does (later valid
 * rows are duplicate parked rows). A valid disabled row qualifies; unknown
 * raw fields do not disqualify it.
 */

/** Fixed compatibility error — an invalid persisted pipeline can never be
 * coerced into a writable empty one. */
export const OPERATOR_SNAPSHOT_INVALID_ERROR =
  '存储的算子管线不完整，无法安全修改；请先在「节点处理」页面检查该来源。';

export type OperatorRowClassification =
  | 'managed-rename'
  | 'valid'
  | 'duplicate-rename'
  | 'runtime-invalid'
  | 'parked';

export interface OperatorRowEntry {
  /** Raw index (identical to the decoded index — 1:1 by construction). */
  index: number;
  /** Exact persisted bytes of this row. */
  raw: unknown;
  /** Aligned decoded management/execution row (undefined only when the
   * stored decode could not produce a per-item row — never happens for
   * array inputs, which always park per item). */
  decoded: StoredOperator | undefined;
  classification: OperatorRowClassification;
  /** Non-empty string id when raw is a plain record with one, else ''. */
  id: string;
}

export interface OperatorSnapshot {
  /** One immutable entry per raw index. */
  rows: readonly OperatorRowEntry[];
  /** Exact persisted operator rows (bytes as stored). */
  raw: unknown[];
  /** Deterministic decoded management/execution view of `raw`. */
  decoded: StoredOperator[];
  /** The LOGICAL managed rename row — the first aligned current-valid
   * rename-template entry, or undefined when none qualifies. */
  managed: OperatorRowEntry | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic decode of a raw operator array (never throws — parks). */
export function decodeRawOperators(raw: unknown): StoredOperator[] {
  try {
    return StoredOperatorListSchema.parse(raw ?? []);
  } catch {
    // a non-array raw value cannot even park per-item — treat as empty
    return [];
  }
}
/**
 * Round-9 classifier: decide the row classification from the ALIGNED raw +
 * decoded pair. The managed eligibility predicate is exact:
 *   - raw is a plain record with exact `kind: 'rename-template'` and a
 *     non-empty string id;
 *   - the aligned decoded row is a plain current-schema `rename-template`
 *     with the SAME id and NO own `compatibility_issue` (Object.hasOwn —
 *     inherited values/getters never demote a valid row).
 * Only the FIRST eligible row consumes the managed slot; later eligible rows
 * are duplicate parked rows. Malformed, unknown and runtime-validation-
 * required rename-shaped rows never qualify.
 */
export function classifyOperatorRow(
  raw: unknown,
  decoded: StoredOperator | undefined,
  managedSlotTaken: boolean,
): { classification: OperatorRowClassification; eligibleManaged: boolean } {
  const rawRename =
    isRecord(raw) && raw.kind === 'rename-template' && typeof raw.id === 'string' && raw.id !== '';
  const decodedPlainRename =
    decoded !== undefined &&
    !isParkedOperator(decoded) &&
    !hasOwnCompatibilityIssue(decoded) &&
    decoded.kind === 'rename-template';
  const aligned =
    rawRename &&
    decodedPlainRename &&
    isRecord(decoded) &&
    typeof decoded.id === 'string' &&
    decoded.id === raw.id;
  if (aligned) {
    if (!managedSlotTaken) return { classification: 'managed-rename', eligibleManaged: true };
    return { classification: 'duplicate-rename', eligibleManaged: false };
  }
  // A row the STORED DECODER parked as a duplicate (second current-valid
  // rename-template) is a duplicate parked row, not runtime-invalid.
  if (
    decoded !== undefined &&
    !isParkedOperator(decoded) &&
    hasOwnCompatibilityIssue(decoded) &&
    decoded.compatibility_issue === STORED_OPERATOR_DUPLICATE_ISSUE
  ) {
    return { classification: 'duplicate-rename', eligibleManaged: false };
  }
  if (decoded !== undefined && !isParkedOperator(decoded) && hasOwnCompatibilityIssue(decoded)) {
    return { classification: 'runtime-invalid', eligibleManaged: false };
  }
  if (decoded !== undefined && isParkedOperator(decoded)) {
    return { classification: 'parked', eligibleManaged: false };
  }
  return { classification: 'valid', eligibleManaged: false };
}

/** Build the dual-view snapshot from a parsed record (symbol first). The
 * persisted raw MUST be an array and raw/decoded lengths MUST match — an
 * invalid persisted pipeline fails the fixed compatibility error BEFORE any
 * mutation (never coerced to a writable empty pipeline). */
export function buildOperatorSnapshot<T extends { operators?: unknown }>(
  record: T,
): OperatorSnapshot {
  const rawValue = (record as WithRawOperators<T>)[RAW_OPERATORS] ?? record.operators;
  if (rawValue === undefined) {
    // an absent operators field IS an empty pipeline
    return { rows: [], raw: [], decoded: [], managed: undefined };
  }
  if (!Array.isArray(rawValue)) {
    throw ProblemDetailsError.unprocessable(OPERATOR_SNAPSHOT_INVALID_ERROR);
  }
  const decoded = decodeRawOperators(rawValue);
  if (decoded.length !== rawValue.length) {
    throw ProblemDetailsError.unprocessable(OPERATOR_SNAPSHOT_INVALID_ERROR);
  }
  const rows: OperatorRowEntry[] = [];
  let managedSlotTaken = false;
  for (let i = 0; i < rawValue.length; i += 1) {
    const rawRow = rawValue[i];
    const decodedRow = decoded[i];
    const { classification, eligibleManaged } = classifyOperatorRow(
      rawRow,
      decodedRow,
      managedSlotTaken,
    );
    if (eligibleManaged) managedSlotTaken = true;
    rows.push({
      index: i,
      raw: rawRow,
      decoded: decodedRow,
      classification,
      id: isRecord(rawRow) && typeof rawRow.id === 'string' ? rawRow.id : '',
    });
  }
  const managed = rows.find((row) => row.classification === 'managed-rename');
  return { rows, raw: [...rawValue], decoded, managed };
}

/**
 * Structural deep equality: arrays are ORDERED (pipeline order is product
 * state), object keys are UNORDERED (JSON object-key order is never product
 * state and never needs byte identity — key-order-only candidates are
 * semantically equal). Primitive values compare with ===.
 */
export function deepEqualKeyOrderInsensitive(a: unknown, b: unknown): boolean {
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
  // JSON semantics: an own key whose value is undefined is ABSENT (zod
  // parsed rows carry optional fields as own `undefined` keys; JSON
  // serialization drops them). Only defined values participate.
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
 * Explicit same-kind edit of a stored row: the candidate's validated known
 * fields win while every UNKNOWN field of the stored raw row is retained
 * (future passthrough fields and legacy fields survive an edit that only
 * touches known keys). A malformed raw row cannot be merged — the candidate
 * replaces it (a malformed row decodes to a parked placeholder and can never
 * be a same-kind match anyway).
 */
export function mergeEditedOperatorRow(rawRow: unknown, candidate: unknown): unknown {
  if (rawRow === null || typeof rawRow !== 'object' || Array.isArray(rawRow)) return candidate;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return candidate;
  }
  return { ...(rawRow as Record<string, unknown>), ...(candidate as Record<string, unknown>) };
}
