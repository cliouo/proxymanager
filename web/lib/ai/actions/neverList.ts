/**
 * Never-List — operations the AI must never perform, checked before any write
 * is even previewed. This is a hard denylist independent of which actions are
 * registered: even if a dangerous action were added to the registry by
 * mistake, the orchestrator refuses it here.
 *
 * Today no registered action is dangerous (the write actions are scoped rule
 * edits), but the guard also caps blast radius and stays as the single place
 * to encode "AI must never touch X" as the action surface grows.
 */

import type { ActionDef } from './types';

/** Action names that must never be AI-invocable, even if registered. */
const NEVER_LIST_ACTIONS = new Set<string>([
  // Examples of what belongs here as the surface grows:
  // 'edit_auth', 'rotate_sub_token', 'overwrite_base', 'bulk_delete_rules'
]);

export class NeverListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeverListError';
  }
}

/**
 * Throw if this action is forbidden for the AI. Called before preview and
 * again before execute (defense in depth).
 */
export function assertWriteAllowed(action: ActionDef): void {
  if (NEVER_LIST_ACTIONS.has(action.name)) {
    throw new NeverListError(`操作 "${action.name}" 不允许由 AI 执行。`);
  }
  if (action.risk !== 'write') {
    // Only write actions go through the confirmation path.
    throw new NeverListError(`"${action.name}" 不是写操作。`);
  }
}
