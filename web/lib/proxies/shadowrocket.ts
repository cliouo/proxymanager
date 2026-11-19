import { ProblemDetailsError } from '@/lib/http/problem';

type Group = Record<string, unknown>;

// This is the subscription remark the user sets when adding the Base64 link.
export const SHADOWROCKET_SUBSCRIPTION = 'ProxyManager-Nodes';

function unsupported(detail: string): never {
  throw ProblemDetailsError.unprocessable(`Shadowrocket 配置无法转换：${detail}`);
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[,=;#\r\n\[\]]/.test(value)) {
    unsupported('策略或参数含有不安全的配置分隔符');
  }
  return value;
}

const groupKeys = new Set([
  'name',
  'type',
  'proxies',
  'include-all-proxies',
  'filter',
  'url',
  'interval',
  'tolerance',
  'lazy',
  'empty-fallback',
]);

function groupLine(group: Group): string {
  const name = token(group.name);
  if (name === SHADOWROCKET_SUBSCRIPTION || !['select', 'url-test'].includes(String(group.type))) {
    unsupported('策略组名称冲突或类型暂不支持');
  }
  if (Object.keys(group).some((key) => !groupKeys.has(key))) unsupported('策略组含有未支持的属性');
  const members = ((group.proxies ?? []) as string[]).map(token);
  if (group['include-all-proxies']) {
    if (members.length) unsupported('暂不支持混合手选成员与全部节点');
    members.push(SHADOWROCKET_SUBSCRIPTION, 'use=true');
  }
  if (!members.length) unsupported('策略组缺少成员');
  if (group.filter) members.push(`policy-regex-filter=${token(group.filter)}`);
  for (const key of ['url', 'interval', 'tolerance']) {
    if (group[key] !== undefined) members.push(`${key}=${token(String(group[key]))}`);
  }
  return `${name} = ${group.type}, ${members.join(', ')}`;
}

const supportedRules = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'GEOIP',
  'IP-CIDR',
  'IP-CIDR6',
]);

export function renderShadowrocket(config: Record<string, unknown>): string {
  const groups = ((config['proxy-groups'] ?? []) as Group[]).map(groupLine);
  const rules: string[] = [];
  let skipped = 0;
  for (const line of (config.rules ?? []) as string[]) {
    const [type, ...args] = line.split(',');
    if (type === 'PROCESS-NAME' || type === 'PROCESS-PATH') {
      skipped++;
      continue;
    }
    if (type === 'MATCH' && args.length === 1) rules.push(`FINAL,${token(args[0])}`);
    else if (
      supportedRules.has(type) &&
      (args.length === 2 || (args.length === 3 && args[2] === 'no-resolve'))
    ) {
      rules.push([type, ...args.map(token)].join(','));
    } else unsupported('包含暂不支持的分流规则');
  }
  return [
    `# Node subscription remark: ${SHADOWROCKET_SUBSCRIPTION}`,
    `# Desktop process rules omitted: ${skipped}`,
    '[Proxy Group]',
    ...groups,
    '',
    '[Rule]',
    ...rules,
    '',
  ].join('\n');
}
