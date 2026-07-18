/**
 * Action layer — the unit the assistant (and, later, any AI surface) can
 * invoke. This is the refract "Action" idea grafted onto ProxyManager:
 * a single typed definition the orchestrator turns into a DeepSeek
 * function-calling tool, dispatches, and — for writes — gates behind a
 * human confirmation handshake.
 *
 * Two shapes:
 *   - read  : `run` executes immediately, no side effects.
 *   - write : never executes inline. `preview` builds a diff for the
 *             confirmation card; `execute` performs the mutation (via the
 *             existing scenario dispatcher, so audit + undo come for free)
 *             and only runs after the user authorises it through
 *             /api/v1/assistant/confirm.
 *
 * `dangerous` operations are never registered — they live on the Never-List
 * (see ./neverList.ts) and stay REST/UI-only.
 */

import type { z } from 'zod';

export type ActionRisk = 'read' | 'write';

/** Minimal context handed to an action handler. */
export interface ActionContext {
  /** Audit actor label, resolved from `X-Source` (e.g. "web-ui", "ai_chat"). */
  actor: string;
  /**
   * The profile the assistant edits (Phase 2: base/rules/proxy-groups are
   * per-profile). Read/write actions pass this to the scoped repos/dispatch.
   */
  profileId: string;
  /**
   * Immutable facts captured while the human confirmation card was built.
   * Write actions that depend on a stable preview must fail closed when their
   * required guard is absent or no longer matches current storage.
   */
  confirmation?: {
    configVersion?: number;
  };
}

/**
 * Typed JSON envelope returned by every action. The front-end renders it
 * by `kind` through a component registry — the model never emits HTML or
 * markdown for an action result, only trusted prefab components draw it.
 */
export interface ActionEnvelope {
  /** Component id the UI renders (e.g. "rule-list", "doc-citation"). */
  kind: string;
  /** Payload for that component. Also fed back to the model as the tool result. */
  data: unknown;
  /**
   * When true, `data` holds untrusted external text (e.g. fetched docs) and
   * the orchestrator wraps it in a spotlighting delimiter before returning
   * it to the model. See orchestrator injection isolation.
   */
  untrusted?: boolean;
}

/** What the confirmation card shows before the user authorises a write. */
export interface WritePreview {
  /** Tagged diff: { op: 'add' | 'update' | 'delete', before?, after? }. */
  diff: unknown;
  /** Optional concurrency guard stored beside the one-time confirmation. */
  confirmation?: {
    configVersion?: number;
  };
}

interface BaseAction<I extends z.ZodType> {
  /** verb_noun, snake_case — becomes the tool function name. */
  name: string;
  /** ≤200 chars, includes trigger keywords; shown to the model. */
  description: string;
  /** Input schema — drives both runtime validation and the tool JSON Schema. */
  input: I;
}

export interface ReadActionDef<I extends z.ZodType = z.ZodType> extends BaseAction<I> {
  risk: 'read';
  run: (ctx: ActionContext, input: z.infer<I>) => Promise<ActionEnvelope>;
}

export interface WriteActionDef<I extends z.ZodType = z.ZodType> extends BaseAction<I> {
  risk: 'write';
  /** Human-readable one-liner for the confirmation card. */
  summary: (input: z.infer<I>) => string;
  /** Build a diff without committing anything. */
  preview: (ctx: ActionContext, input: z.infer<I>) => Promise<WritePreview>;
  /** Perform the mutation. Only called after the user authorises the token. */
  execute: (ctx: ActionContext, input: z.infer<I>) => Promise<ActionEnvelope>;
}

export type ActionDef<I extends z.ZodType = z.ZodType> = ReadActionDef<I> | WriteActionDef<I>;

/** Define a read action (executes immediately). */
export function defineAction<I extends z.ZodType>(def: ReadActionDef<I>): ReadActionDef<I> {
  return def;
}

/** Define a write action (gated behind the confirmation handshake). */
export function defineWriteAction<I extends z.ZodType>(def: WriteActionDef<I>): WriteActionDef<I> {
  return def;
}
