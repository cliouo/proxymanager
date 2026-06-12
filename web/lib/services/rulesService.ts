import { mergePolicyUniverse, parseBase, type ParsedBase } from '@/lib/engine/parser';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import type { Rule } from '@/schemas';

/**
 * 解析存库的 base，返回**已合并策略全集**的 ParsedBase：`policies` =
 * 托管策略组(hash，rank 序) + base 字面(残留组/手写节点/内建)。规则写入
 * 校验(ensureValidAnchorAndPolicy 的全部调用方)与 AI 的 base 概览都吃
 * 这里——策略组迁出 base.yaml 后，裸 parseBase 的 policies 不再是合法
 * 目标全集，直接用会把指向托管组的规则误判孤立。
 */
export async function loadParsedBase(): Promise<ParsedBase> {
  const [base, groups] = await Promise.all([getBase(), listProxyGroups()]);
  if (!base) {
    throw ProblemDetailsError.unprocessable(
      'Base config has not been initialized. Set base before creating rules.',
    );
  }
  const parsed = parseBase(base.content);
  return {
    ...parsed,
    policies: mergePolicyUniverse(
      groups.map((g) => g.name),
      parsed.policies,
    ),
  };
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
      `policy "${rule.policy}" 不存在——既不是策略组，也不是 base.yaml 里的节点/内建策略`,
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
