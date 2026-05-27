import type { BaseOrphan, BaseValidationResult, Rule } from '@/schemas';
import type { ParsedBase } from './parser';

export function validateBase(
  parsed: ParsedBase,
  rules: Rule[],
  /** Rule-set library names. When supplied, RULE-SET rules pointing outside it are flagged. */
  providerNames?: Set<string>,
): BaseValidationResult {
  const anchorSet = new Set(parsed.anchors);
  const policySet = new Set(parsed.policies);
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
        reason: `policy "${rule.policy}" not present in proxy-groups`,
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
    policies: parsed.policies,
    orphans,
  };
}
