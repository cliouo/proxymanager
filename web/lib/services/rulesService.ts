import { parseBase, type ParsedBase } from '@/lib/engine/parser';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import type { Rule } from '@/schemas';

export async function loadParsedBase(): Promise<ParsedBase> {
  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.unprocessable(
      'Base config has not been initialized. Set base before creating rules.',
    );
  }
  return parseBase(base.content);
}

export function ensureValidAnchorAndPolicy(
  rule: Pick<Rule, 'anchor' | 'policy'>,
  parsed: ParsedBase,
): void {
  if (!parsed.anchors.includes(rule.anchor)) {
    throw ProblemDetailsError.unprocessable(`anchor "${rule.anchor}" not present in base.yaml`);
  }
  if (!parsed.policies.includes(rule.policy)) {
    throw ProblemDetailsError.unprocessable(
      `policy "${rule.policy}" not present in base.yaml proxy-groups`,
    );
  }
}

export async function computeNextRank(anchor: string): Promise<number> {
  const all = await listRules();
  const inAnchor = all.filter((r) => r.anchor === anchor);
  if (inAnchor.length === 0) return 10;
  const max = Math.max(...inAnchor.map((r) => r.rank));
  return max + 10;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function generateRuleId(): string {
  return crypto.randomUUID();
}
