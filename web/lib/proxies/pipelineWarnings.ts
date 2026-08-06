/**
 * Cross-operator warnings the workbench surfaces (criterion 7). Pure +
 * deterministic so the UI logic is testable without a component harness.
 */

import { validateTemplate } from '@/lib/proxies/naming';
import type { StoredOperator } from '@/schemas/operator';

/**
 * Whether an enabled rename step (rename-regex with a pattern, or an enabled
 * rename-template) runs BEFORE the operator at `index` in the ordered
 * pipeline — i.e. whether a filter-regex at that position matches already-
 * renamed names instead of the raw/original ones.
 */
export function matchesRenamedAt(operators: readonly StoredOperator[]): boolean[] {
  const out = new Array<boolean>(operators.length).fill(false);
  let sawRename = false;
  for (let i = 0; i < operators.length; i += 1) {
    const op = operators[i];
    if (op.disabled) continue;
    if (op.kind === 'rename-regex') {
      if (op.pattern && op.pattern.trim() !== '') sawRename = true;
    } else if (op.kind === 'rename-template') {
      sawRename = true;
    }
    out[i] = sawRename;
  }
  return out;
}

/** Whether a valid template references the `${emoji}` placeholder. */
function templateUsesEmoji(template: string): boolean {
  const validation = validateTemplate(template);
  if (!validation.ok) return false;
  return validation.tokens.some(
    (t) =>
      (t.type === 'field' && t.field === 'emoji') || (t.type === 'optional' && t.field === 'emoji'),
  );
}

/**
 * Indexes of enabled rename-capable steps (rename-regex with a pattern,
 * flag-emoji) that run AFTER an active rename-template. Such orderings are
 * REJECTED by the shared list schema (「名称统一」is the final rename stage);
 * this exposes them to the workbench BEFORE the user hits save.
 */
export function renamedAfterManaged(operators: readonly StoredOperator[]): number[] {
  const out: number[] = [];
  let managedSeen = false;
  operators.forEach((op, i) => {
    if (op.disabled) return;
    if (op.kind === 'rename-template') {
      managedSeen = true;
      return;
    }
    if (!managedSeen) return;
    if (op.kind === 'rename-regex' && op.pattern && op.pattern.trim() !== '') {
      out.push(i);
    } else if (op.kind === 'flag-emoji') {
      out.push(i);
    }
  });
  return out;
}

/**
 * Flag redundancy: an enabled rename-template whose template renders the
 * flag emoji AND an enabled flag-emoji `add` step elsewhere. Both are kept —
 * the UI only warns, never removes either.
 */
export function hasFlagRedundancy(operators: readonly StoredOperator[]): boolean {
  const rt = operators.find(
    (op): op is Extract<StoredOperator, { kind: 'rename-template' }> =>
      op.kind === 'rename-template' && !op.disabled,
  );
  if (!rt) return false;
  return (
    templateUsesEmoji(rt.template) &&
    operators.some((op) => op.kind === 'flag-emoji' && op.action === 'add' && !op.disabled)
  );
}
