import type { ShadowrocketRuleIssue } from '@/lib/engine/shadowrocketCompatibility';

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRuleIssue(value: unknown): value is ShadowrocketRuleIssue {
  if (!value || typeof value !== 'object') return false;
  const issue = value as Partial<ShadowrocketRuleIssue>;
  if (issue.status !== 'incompatible' && issue.status !== 'unverified') return false;
  if (typeof issue.reason !== 'string') return false;
  const hasRule =
    issue.ruleNumber !== undefined || issue.ruleType !== undefined || issue.target !== undefined;
  if (hasRule) {
    if (
      typeof issue.ruleNumber !== 'number' ||
      !Number.isInteger(issue.ruleNumber) ||
      issue.ruleNumber <= 0 ||
      typeof issue.ruleType !== 'string' ||
      typeof issue.target !== 'string'
    )
      return false;
  }
  const hasTun = issue.field !== undefined || issue.setName !== undefined;
  if (hasTun && (typeof issue.field !== 'string' || typeof issue.setName !== 'string'))
    return false;
  const hasListener = issue.listener !== undefined || issue.table !== undefined;
  if (hasListener && (typeof issue.listener !== 'string' || typeof issue.table !== 'string'))
    return false;
  if (!hasRule && !hasTun && !hasListener && typeof issue.mode !== 'string') return false;
  return [
    issue.reference,
    issue.listener,
    issue.table,
    issue.member,
    issue.option,
    issue.field,
    issue.setName,
    issue.mode,
  ].every(optionalString);
}

export async function recheckShadowrocket(
  url: string,
  signal: AbortSignal,
): Promise<ShadowrocketRuleIssue[]> {
  let response: Response;
  try {
    // The saved link serves unverified routing; strict=1 makes it list every finding.
    response = await fetch(`${url}&strict=1`, { credentials: 'omit', cache: 'no-store', signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('网络连接失败，请重试。');
  }
  if (response.status === 200) {
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'text/yaml')
      return [];
    throw new Error('订阅链接未返回 YAML 配置，请检查访问地址。');
  }
  if (response.status === 401) throw new Error('订阅令牌已失效，请重新获取设备链接。');
  const problem = await response.json().catch(() => null);
  if (
    response.status === 422 &&
    Array.isArray(problem?.errors) &&
    problem.errors.length &&
    problem.errors.every(isRuleIssue)
  ) {
    return problem.errors;
  }
  throw new Error(
    typeof problem?.detail === 'string'
      ? problem.detail
      : `订阅请求失败（HTTP ${response.status}）。`,
  );
}
