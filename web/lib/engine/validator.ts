import type { BaseOrphan, BaseValidationResult, Rule } from '@/schemas';
import { mergePolicyUniverse, type ParsedBase } from './parser';

export function validateBase(
  parsed: ParsedBase,
  rules: Rule[],
  /** Rule-set library names. When supplied, RULE-SET rules pointing outside it are flagged. */
  providerNames?: Set<string>,
  /**
   * 托管策略组名（proxy-groups hash）。策略组已迁出 base.yaml——骨架里只有
   * `# === PROXY-GROUPS ===` 注入标记，不传这个参数会把指向托管组的规则
   * 全部误判孤立。真实校验路径（base 保存 / AI 改 base）必须传；省略仅适
   * 用于只关心 base 字面内容的纯解析测试。
   */
  managedGroupNames?: string[],
): BaseValidationResult {
  const anchorSet = new Set(parsed.anchors);
  const policies = mergePolicyUniverse(managedGroupNames ?? [], parsed.policies);
  const policySet = new Set(policies);
  const orphans: BaseOrphan[] = [];

  for (const rule of rules) {
    if (!anchorSet.has(rule.anchor)) {
      orphans.push({
        rule_id: rule.id,
        reason: `anchor "${rule.anchor}" not present in base.yaml`,
      });
    }
    if (!policySet.has(rule.policy)) {
      orphans.push({
        rule_id: rule.id,
        reason: `policy "${rule.policy}" 不存在——既不是策略组，也不是 base.yaml 里的节点/内建策略`,
      });
    }
    if (providerNames && rule.type === 'RULE-SET' && rule.value && !providerNames.has(rule.value)) {
      orphans.push({
        rule_id: rule.id,
        reason: `RULE-SET 引用的规则集 "${rule.value}" 不在规则集库中`,
      });
    }
  }

  return {
    valid: orphans.length === 0,
    anchors: parsed.anchors,
    // 合并后的全集——base 页 Inspector 与 validate API 直接展示它。
    policies,
    orphans,
  };
}
