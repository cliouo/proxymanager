import { parseBase, type ParsedBase } from '@/lib/engine/parser';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
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

/** Names of every rule-set in the library — the valid targets for a RULE-SET rule. */
export async function loadProviderNames(): Promise<Set<string>> {
  const sets = await listRuleSets();
  return new Set(sets.map((s) => s.name));
}

/**
 * A RULE-SET rule's `value` must name a rule-set in the library (otherwise the
 * renderer can't emit a `rule-providers:` declaration for it and mihomo errors
 * at load). No-op for every other rule type.
 */
export function ensureValidRuleSetRef(
  rule: Pick<Rule, 'type' | 'value'>,
  providerNames: Set<string>,
): void {
  if (rule.type !== 'RULE-SET') return;
  if (!rule.value || !providerNames.has(rule.value)) {
    throw ProblemDetailsError.unprocessable(
      `RULE-SET 规则引用的规则集 "${rule.value}" 不存在于规则集库；请先到「规则集」页创建，或从下拉中选择已有的。`,
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

/**
 * Resolve an actor label from request headers. Defaults to "admin" since the
 * proxy guard has already validated the Bearer key; clients can self-identify
 * via `X-Source` (e.g. "extension", "web-ui") so the audit log can distinguish
 * call sites without separate credentials.
 */
export function resolveActor(request: Request): string {
  const source = request.headers.get('x-source')?.trim();
  if (source) return source.slice(0, 64);
  return 'admin';
}
