import type { Rule } from '@/schemas';
import type { RuleSummary } from '@/lib/client/rule-summary';
export function summarizeRules(rules: Rule[]): RuleSummary {
  const anchors: Record<string, { total: number; active: number }> = Object.create(null);
  const policies: Record<string, number> = Object.create(null);
  const ruleSets: Record<string, number> = Object.create(null);
  let active = 0;
  for (const r of rules) {
    const enabled = r.enabled !== false;
    if (enabled) active++;
    const anchor = (anchors[r.anchor] ??= { total: 0, active: 0 });
    anchor.total++;
    if (enabled) anchor.active++;
    policies[r.policy] = (policies[r.policy] ?? 0) + 1;
    if (r.type === 'RULE-SET') ruleSets[r.value] = (ruleSets[r.value] ?? 0) + 1;
  }
  return {
    total: rules.length,
    active,
    disabled: rules.length - active,
    anchors,
    policies,
    ruleSets,
  };
}
