/**
 * writeResultProjection — the SINGLE model-safe confirmed-write projection.
 *
 * Runs ONLY after a successful action.execute. The write action envelope is
 * internal UI data (op/summary/result/events); the model must never receive
 * the raw envelope: nested results can carry raw ids, stable keys, audit
 * storage keys, URLs and credentials.
 *
 * Hardened serialization (round-9):
 *   - All record objects that will be serialized have null prototypes.
 *   - Arrays retain their Array internal slot but carry an own non-enumerable
 *     data `toJSON` property with value `undefined`, shadowing
 *     Object.prototype.toJSON / Array.prototype.toJSON.
 *   - Every property descriptor passed to Object.defineProperty is itself
 *     null-prototype, built via safe property assignment (never
 *     Object.defineProperty with an ordinary literal).
 *   - Descriptor validation requires own `value`, no own `get`, no own `set`
 *     (never reads inherited accessor metadata).
 *   - responseContent, modelContent and the unknown-outcome body are built
 *     deterministically from primitive strings without JSON.stringify on
 *     ordinary records/arrays.
 */

import { types } from 'node:util';
import {
  RECEIPT_OP_MAX,
  RECEIPT_OP_RAW_MAX,
  RECEIPT_SUMMARY_MAX,
  RECEIPT_SUMMARY_RAW_MAX,
  canonicalizeReceiptText,
} from './receiptPolicy.generated';

/** Registry-style action names: snake_case, non-empty, <= 128. */
const ACTION_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Production-compatible lower-kebab op token beginning with a letter. */
const OP_KEBAB_RE = /^[a-z][a-z0-9-]*$/;

/* ─── Round-9 hardened descriptor / record helpers ──────────────────── */

/**
 * Create a null-prototype property descriptor. Built by first creating a
 * null-prototype record via Object.create(null), then assigning each own
 * data property via safe indexed assignment — every step avoids
 * Object.defineProperty with an ordinary literal descriptor.
 */
function nullProtoDescriptor(
  value: unknown,
  opts: { writable?: boolean; enumerable?: boolean; configurable?: boolean } = {},
): PropertyDescriptor {
  const desc = Object.create(null);
  desc.value = value;
  desc.writable = opts.writable ?? true;
  desc.enumerable = opts.enumerable ?? true;
  desc.configurable = opts.configurable ?? true;
  return desc;
}

/**
 * Create a null-prototype record with the given own data properties.
 * Uses Object.defineProperty with null-proto descriptors — never
 * ordinary literal descriptors.
 */
function defineOwnData(
  target: object,
  key: PropertyKey,
  value: unknown,
  opts: { writable?: boolean; enumerable?: boolean; configurable?: boolean } = {},
): void {
  Object.defineProperty(target, key, nullProtoDescriptor(value, opts));
}

/** JSON-escape a primitive string — JSON.stringify on a primitive string
 * is safe: it never invokes toJSON, never walks prototypes. */
function jsonEscapeString(s: string): string {
  return JSON.stringify(s);
}

/* ─── Fixed unknown-outcome response body ───────────────────────────── */

/** Deterministic JSON string, built from fixed text + escaped strings only.
 * Never calls JSON.stringify on an ordinary record. */
const UNKNOWN_OUTCOME_BODY =
  '{"data":{"kind":"unknown-outcome","modelContent":' +
  jsonEscapeString(
    'The write outcome is unknown. Do not retry automatically; re-read the target profile to verify the current state.',
  ) +
  '}}';

/* ─── Guard functions ───────────────────────────────────────────────── */

function isStrictPlainRecord(value: unknown): value is Record<string, unknown> {
  if (types.isProxy(value)) return false;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) return false;
    if (!descriptor.enumerable) return false;
    // Round-9: require own `value` AND no own `get`/`set`
    if (!Object.hasOwn(descriptor, 'value')) return false;
    if (Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) return false;
  }
  return true;
}

function hasExactKeys(record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== keys.length) return false;
  for (const name of names) {
    if (!keys.includes(name)) return false;
  }
  return true;
}

const DATA_KEYS = ['op', 'summary', 'result', 'events'] as const;

/* ─── Public types ──────────────────────────────────────────────────── */

export interface UiWriteResultEnvelope {
  kind: 'write-result';
  data: {
    op: string;
    summary: string;
    events: Array<{
      id: string;
      op: string;
      undoable?: boolean;
    }>;
  };
}

export interface WriteResultProjection {
  outcome: 'ok' | 'unknown';
  uiEnvelope: UiWriteResultEnvelope | null;
  modelContent: string | null;
  /** Pre-serialized HTTP response body (null for unknown — callers use
   * the fixed UNKNOWN_OUTCOME_BODY). */
  responseContent: string | null;
}

/* ─── Event array snapshot ──────────────────────────────────────────── */

function snapshotStrictEventArray(events: unknown): unknown[] | null {
  if (types.isProxy(events) || !Array.isArray(events)) return null;
  if (Object.getPrototypeOf(events) !== Array.prototype) return null;
  if (Object.getOwnPropertySymbols(events).length > 0) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(events, 'length');
  if (lengthDescriptor === undefined) return null;
  if (!Object.hasOwn(lengthDescriptor, 'value')) return null;
  if (Object.hasOwn(lengthDescriptor, 'get') || Object.hasOwn(lengthDescriptor, 'set')) return null;
  if (typeof lengthDescriptor.value !== 'number') return null;
  const length = lengthDescriptor.value;
  if (!Number.isInteger(length) || length < 0 || length > 64) return null;
  const names = Object.getOwnPropertyNames(events);
  if (names.length !== length + 1) return null;
  const snapshot: unknown[] = [];
  // Round-9: define `length` with a null-proto descriptor AND shadow toJSON
  Object.defineProperty(
    snapshot,
    'length',
    nullProtoDescriptor(length, {
      writable: true,
      enumerable: false,
      configurable: false,
    }),
  );
  defineOwnData(snapshot, 'toJSON', undefined, { enumerable: false });
  for (const name of names) {
    if (name === 'length' || name === 'toJSON') continue;
    const index = Number(name);
    if (!Number.isInteger(index) || index < 0 || String(index) !== name || index >= length) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(events, name);
    if (descriptor === undefined) return null;
    if (!descriptor.enumerable) return null;
    if (!Object.hasOwn(descriptor, 'value')) return null;
    if (Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) return null;
    defineOwnData(snapshot, name, descriptor.value);
  }
  return snapshot;
}

function projectEventsStrict(
  events: unknown,
): Array<{ id: string; op: string; undoable?: boolean }> | null {
  const snapshot = snapshotStrictEventArray(events);
  if (snapshot === null) return null;
  const out: Array<{ id: string; op: string; undoable?: boolean }> = [];
  for (let i = 0; i < snapshot.length; i += 1) {
    const event = snapshot[i];
    if (!isStrictPlainRecord(event)) return null;
    if (!hasExactKeys(event, ['id', 'op', 'undoable']) && !hasExactKeys(event, ['id', 'op'])) {
      return null;
    }
    const id = typeof event.id === 'string' ? event.id.trim() : '';
    const op = typeof event.op === 'string' ? event.op.trim() : '';
    if (id === '' || id.length > 64 || op === '' || op.length > 64) return null;
    const undoable = Object.hasOwn(event, 'undoable') ? event.undoable : undefined;
    if (undoable !== undefined && typeof undoable !== 'boolean') return null;
    // Round-9: null-proto event record
    const eventRecord = Object.create(null);
    eventRecord.id = id;
    eventRecord.op = op;
    if (undoable !== undefined) eventRecord.undoable = undoable;
    defineOwnData(out, String(out.length), eventRecord);
  }
  // Round-9: shadow toJSON on the output array
  defineOwnData(out, 'toJSON', undefined, { enumerable: false });
  return out;
}

/* ─── Main projection ───────────────────────────────────────────────── */

export function projectWriteResult(envelope: unknown, actionName: string): WriteResultProjection {
  try {
    return projectWriteResultInner(envelope, actionName);
  } catch {
    return {
      outcome: 'unknown',
      uiEnvelope: null,
      modelContent: null,
      responseContent: UNKNOWN_OUTCOME_BODY,
    };
  }
}

function projectWriteResultInner(envelope: unknown, actionName: string): WriteResultProjection {
  const bad: WriteResultProjection = {
    outcome: 'unknown',
    uiEnvelope: null,
    modelContent: null,
    responseContent: UNKNOWN_OUTCOME_BODY,
  };
  if (typeof actionName !== 'string' || actionName === '' || actionName.length > 128) return bad;
  if (!ACTION_NAME_RE.test(actionName)) return bad;
  if (!isStrictPlainRecord(envelope)) return bad;
  if (!hasExactKeys(envelope, ['kind', 'data'])) return bad;
  if (envelope.kind !== 'write-result') return bad;
  if (!isStrictPlainRecord(envelope.data)) return bad;
  const data = envelope.data;
  for (const key of Object.getOwnPropertyNames(data)) {
    if (!(DATA_KEYS as ReadonlyArray<string>).includes(key)) return bad;
  }
  if (
    !Object.hasOwn(data, 'op') ||
    !Object.hasOwn(data, 'summary') ||
    !Object.hasOwn(data, 'events')
  ) {
    return bad;
  }

  const op = canonicalizeReceiptText(data.op, RECEIPT_OP_RAW_MAX, true);
  if (op === null || op.length > RECEIPT_OP_MAX || !OP_KEBAB_RE.test(op)) return bad;
  const summary = canonicalizeReceiptText(data.summary, RECEIPT_SUMMARY_RAW_MAX, false);
  if (summary === null || summary.length > RECEIPT_SUMMARY_MAX) return bad;
  const events = projectEventsStrict(data.events);
  if (events === null) return bad;

  // ── Round-9: deterministic modelContent from primitive strings only ──
  const modelContent =
    '{"status":"success","action":' +
    jsonEscapeString(actionName) +
    ',"summary":' +
    jsonEscapeString(summary) +
    '}';

  // ── Round-9: deterministic responseContent, never JSON.stringify ──
  const responseContent = buildResponseContent(op, summary, events, modelContent);

  // ── Round-9: null-proto UI envelope ──
  const dataRecord = Object.create(null);
  dataRecord.op = op;
  dataRecord.summary = summary;
  // events array already has own toJSON:undefined shadowing
  dataRecord.events = events;

  const uiRecord = Object.create(null);
  uiRecord.kind = 'write-result';
  uiRecord.data = dataRecord;

  return {
    outcome: 'ok',
    uiEnvelope: uiRecord as unknown as UiWriteResultEnvelope,
    modelContent,
    responseContent,
  };
}

/** Deterministic HTTP response body: builds
 * {"data":{"kind":"write-result","data":{"op":...,"summary":...,"events":[...]},"modelContent":"..."}}
 * from primitive strings only. */
function buildResponseContent(
  op: string,
  summary: string,
  events: Array<{ id: string; op: string; undoable?: boolean }>,
  modelContent: string,
): string {
  let eventsJson = '[';
  for (let i = 0; i < events.length; i += 1) {
    if (i > 0) eventsJson += ',';
    const ev = events[i];
    eventsJson += '{';
    eventsJson += '"id":' + jsonEscapeString(ev.id);
    eventsJson += ',"op":' + jsonEscapeString(ev.op);
    if (ev.undoable !== undefined) {
      eventsJson += ',"undoable":' + (ev.undoable ? 'true' : 'false');
    }
    eventsJson += '}';
  }
  eventsJson += ']';

  return (
    '{"data":{' +
    '"kind":"write-result",' +
    '"data":{' +
    '"op":' +
    jsonEscapeString(op) +
    ',' +
    '"summary":' +
    jsonEscapeString(summary) +
    ',' +
    '"events":' +
    eventsJson +
    '},' +
    '"modelContent":' +
    jsonEscapeString(modelContent) +
    '}}'
  );
}

export { UNKNOWN_OUTCOME_BODY };
