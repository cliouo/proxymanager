import type { ShadowrocketRuleIssue } from '@/lib/engine/shadowrocketCompatibility';

function isRuleIssue(value: unknown): value is ShadowrocketRuleIssue {
  if (!value || typeof value !== 'object') return false;
  const issue = value as Partial<ShadowrocketRuleIssue>;
  return (
    (issue.status === 'incompatible' || issue.status === 'unverified') &&
    typeof issue.ruleNumber === 'number' &&
    Number.isInteger(issue.ruleNumber) &&
    issue.ruleNumber > 0 &&
    typeof issue.ruleType === 'string' &&
    typeof issue.target === 'string' &&
    typeof issue.reason === 'string' &&
    (issue.reference === undefined || typeof issue.reference === 'string')
  );
}

export async function recheckShadowrocket(
  url: string,
  signal: AbortSignal,
): Promise<ShadowrocketRuleIssue[]> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', cache: 'no-store', signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('网络连接失败，请重试。');
  }
  if (response.status === 200) return [];
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
