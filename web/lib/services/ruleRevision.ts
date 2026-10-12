import { isDeepStrictEqual } from 'node:util';
import { ProblemDetailsError } from '@/lib/http/problem';
import type { Rule } from '@/schemas';

export function assertRuleRevision(rule: Rule, expected?: number): void {
  if (expected !== undefined && (rule.revision ?? 0) !== expected) {
    throw ProblemDetailsError.preconditionFailed(
      '规则已被其他操作修改，请刷新后重试。草稿已保留。',
    );
  }
}

/** Legacy snapshots have no revision; full comparison also protects every old write path. */
export function sameRuleState(current: Rule, snapshot: Rule): boolean {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(current)),
    JSON.parse(JSON.stringify(snapshot)),
  );
}
