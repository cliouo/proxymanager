import type { ShadowrocketRuleIssue } from './shadowrocketCompatibility';

/** One human-readable location shared by the API detail and the device page. */
export function describeShadowrocketIssueLocation(issue: ShadowrocketRuleIssue): string {
  if (issue.listener) {
    const table = `监听器 ${issue.listener} · 子规则表 ${issue.table ?? '?'}`;
    return issue.ruleNumber === undefined
      ? table
      : `${table} 第 ${issue.ruleNumber} 条规则 ${issue.ruleType} → ${issue.target}`;
  }
  if (issue.field && issue.setName) {
    return `TUN 字段 ${issue.field} 引用的规则集 ${issue.setName}`;
  }
  if (issue.mode) {
    return `运行模式 ${issue.mode} 的实际出口 ${issue.reference ?? issue.target ?? '未定'}`;
  }
  return issue.ruleNumber === undefined
    ? '配置诊断'
    : `第 ${issue.ruleNumber} 条规则 ${issue.ruleType} → ${issue.target}`;
}
