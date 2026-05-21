/**
 * Scenario framework — type contracts.
 *
 * A "scenario" is a self-contained module that owns a slice of the Clash
 * config experience. Each scenario declares:
 *   - a descriptor (id, title, sidebar entry)
 *   - one or more named ops, each a pure async handler
 *
 * Ops are dispatched through `POST /api/v1/ops` with body
 * `{ scenario, op, payload }`. The dispatcher constructs an `OpContext`
 * providing scoped storage stubs, runs the handler, persists the audit
 * events the handler returns, and propagates `data` back to the caller.
 *
 * This file is the single contract between framework and scenarios — do
 * not import anything except types here.
 */

import type { Document } from 'yaml';
import type { Rule } from '@/schemas';

/* ─── User-defined taxonomy ──────────────────────────────────────────── */

export type GroupKind = 'regional' | 'platform' | 'custom' | 'unknown';

export interface GroupTag {
  kind: GroupKind;
  /** Free-form region code/label when kind=regional. e.g. 'HK', '美国'. */
  region?: string;
  /** Hex colour used by the UI. */
  color?: string;
}

/* ─── Audit ─────────────────────────────────────────────────────────── */

export type AuditTarget =
  | { kind: 'rule'; id: string }
  | { kind: 'proxy'; name: string }
  | { kind: 'proxy-group'; name: string }
  | { kind: 'base'; field?: string };

/**
 * What a handler emits per mutation. The dispatcher prefixes `action` with
 * the scenario id to form the final audit op string (e.g.
 * `chained-proxy.set-dialer`).
 */
export interface AuditEventInput {
  action: string;
  target: AuditTarget;
  before?: unknown;
  after?: unknown;
}

/* ─── Op results ────────────────────────────────────────────────────── */

export interface OpResult {
  /** Returned to the HTTP caller in the `data` envelope. */
  data: unknown;
  /** Recorded into the audit log post-handler. */
  events: AuditEventInput[];
}

/* ─── Storage stubs handlers can use ────────────────────────────────── */

export interface BaseReadResult {
  doc: Document;
  etag: string;
  updated_at: number;
}

export interface BaseStore {
  /** Snapshot of current base.yaml as a parsed YAML Document plus metadata. */
  read(): Promise<BaseReadResult>;
  /**
   * Read, hand the live Document to `mutate` (which edits it in place),
   * serialise + commit. Refuses with 412 if base was modified between read
   * and write (ETag race). Returns the new ETag and whatever `mutate`
   * returns.
   */
  withDocument<T>(mutate: (doc: Document) => T | Promise<T>): Promise<{ result: T; etag: string }>;
}

export interface RulesStore {
  list(filter?: { anchor?: string }): Promise<Rule[]>;
  get(id: string): Promise<Rule | null>;
  upsert(rule: Rule): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** Strictly increasing rank within an anchor; used when caller doesn't pin one. */
  computeNextRank(anchor: string): Promise<number>;
}

export interface TaxonomyStore {
  all(): Promise<Record<string, GroupTag>>;
  get(name: string): Promise<GroupTag | null>;
  set(name: string, tag: GroupTag): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export interface OpContext {
  /** Source label resolved from request `X-Source` header. */
  actor: string;
  base: BaseStore;
  rules: RulesStore;
  taxonomy: TaxonomyStore;
}

export type OpHandler = (ctx: OpContext, payload: unknown) => Promise<OpResult>;

/* ─── Scenario descriptor ───────────────────────────────────────────── */

export interface ScenarioDescriptor {
  id: string;
  title: string;
  description?: string;
  /**
   * Optional sidebar entry. Should match a real Next.js route under
   * `app/(authed)/scenarios/{id}/page.tsx`.
   */
  navHref?: string;
}

/**
 * Inverse of a recorded mutation. Called by `/history/{id}/undo` when the
 * audit event's op matches a scenario action that registered one. Returns
 * a normal OpResult — the inverse mutation itself gets audited as a new
 * event (with `undoes: <original>` set by the undo handler).
 *
 * Receives the original event so it can extract `before`/`after` snapshots
 * and apply optimistic-concurrency checks.
 */
export type InverseHandler = (
  ctx: OpContext,
  event: { id: string; before?: unknown; after?: unknown; target?: AuditTarget; ruleId?: string },
) => Promise<OpResult>;

export interface Scenario {
  descriptor: ScenarioDescriptor;
  ops: Record<string, OpHandler>;
  /**
   * Action-name → inverse handler. Action names match the second half of
   * audit op strings (`${scenarioId}.${action}`). Scenarios may register a
   * subset — actions without an inverse are simply not undoable.
   */
  inverses?: Record<string, InverseHandler>;
}
