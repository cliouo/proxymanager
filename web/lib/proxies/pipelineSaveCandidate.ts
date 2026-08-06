/**
 * Workbench save-candidate validation — the ONE place that mirrors the shared
 * current-write list contract (max 64, at-most-one rename-template, unique
 * ids) for the UI. Per-item `isComplete` can never catch list-level failures:
 * a stored duplicate rename-template passes per-item parsing but must be
 * rejected the moment the stripped candidate is validated as a list.
 */

import {
  hasOwnCompatibilityIssue,
  isParkedOperator,
  OperatorListSchema,
  type Operator,
  type StoredOperator,
} from '@/schemas/operator';

/**
 * The candidate that would actually be persisted: parked placeholders are
 * never savable (the UI blocks them with its own message), and runtime-parked
 * diagnostics are stripped — the API schema has no `compatibility_issue`.
 * Uses Object.hasOwn via hasOwnCompatibilityIssue so an inherited
 * prototype value/getter never triggers stripping.
 */
export function buildSaveCandidate(operators: readonly StoredOperator[]): Operator[] {
  return operators
    .filter((op): op is Operator => !isParkedOperator(op))
    .map((op) => {
      if (hasOwnCompatibilityIssue(op)) {
        const rest = { ...op };
        delete rest.compatibility_issue;
        return rest as Operator;
      }
      return op;
    });
}

export type SaveCandidateCheck = { ok: true } | { ok: false; message: string };

/** Shared-contract gate: the STRIPPED candidate must parse under OperatorListSchema. */
export function validateSaveCandidate(operators: readonly StoredOperator[]): SaveCandidateCheck {
  const candidate = buildSaveCandidate(operators);
  const parsed = OperatorListSchema.safeParse(candidate);
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    message: parsed.error.issues[0]?.message ?? '算子列表不合法',
  };
}

export interface PipelineStatus {
  kind: 'parked' | 'over-limit' | 'at-limit' | 'invalid';
  message: string;
}

/**
 * Visible accessible save-state text (final repair pass group 4): one
 * most-specific message for the current pipeline state — parked history,
 * over-64 loaded history, exactly-64 add block, or a shared-contract
 * validation failure. The workbench renders it in a persistent role=status
 * region (never title-only) while keeping every removal/reduction control
 * usable.
 */
export function pipelineStatusMessage(operators: readonly StoredOperator[]): PipelineStatus | null {
  const parkedCount = operators.filter(isParkedOperator).length;
  if (parkedCount > 0) {
    return {
      kind: 'parked',
      message: `存在 ${parkedCount} 个无法解码的历史步骤（已停用且不会执行）。删除这些步骤后可继续保存。`,
    };
  }
  if (operators.length > 64) {
    return {
      kind: 'over-limit',
      message: `当前共 ${operators.length} 个步骤，超过 64 个上限。请删除 ${operators.length - 64} 个步骤后再保存。`,
    };
  }
  const contract = validateSaveCandidate(operators);
  if (!contract.ok) {
    return { kind: 'invalid', message: `无法保存：${contract.message}。请修正后重试。` };
  }
  if (operators.length === 64) {
    return {
      kind: 'at-limit',
      message: '已达 64 个步骤上限，无法继续添加步骤（删除后可再添加）。',
    };
  }
  return null;
}

/**
 * Unified save-block reason: at-limit (exactly 64 VALID steps) is
 * informational only — it disables Add, never Save. Every other status kind
 * blocks saving with its actionable message.
 */
export function saveBlockedBy(operators: readonly StoredOperator[]): string | null {
  const status = pipelineStatusMessage(operators);
  if (!status || status.kind === 'at-limit') return null;
  return status.message;
}
