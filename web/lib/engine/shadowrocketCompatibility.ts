import { parse } from 'yaml';
import { parseAndValidateFinalRule } from './resolve';

export interface ShadowrocketRuleIssue {
  status: 'incompatible' | 'unverified';
  ruleNumber: number;
  ruleType: string;
  target: string;
  reason: string;
  reference?: string;
}

// Input is the final YAML accepted by the device renderer. Its names are unique,
// its select graph is acyclic, and all explicit members and rule targets resolve.
type Named = { name: string; type: string; [key: string]: unknown };
interface FinalConfig {
  mode?: string;
  proxies?: Named[];
  'proxy-groups'?: Named[];
  'rule-providers'?: Record<string, { type?: string }>;
  rules?: string[];
}
type Finding = Pick<ShadowrocketRuleIssue, 'reason' | 'reference'>;
const onlyKeys = (entry: Named, allowed: string[]) =>
  Object.keys(entry).every((key) => allowed.includes(key));

// Build 3488 and Mihomo v1.19.28: plain HTTP exits, up to three explicit select
// levels, or a nonempty top-level ^HK- select. No unmatched-host exit was recorded.
function targetChecker(config: FinalConfig) {
  const proxies = new Map(config.proxies?.map((p) => [p.name, p]));
  const groups = new Map(config['proxy-groups']?.map((g) => [g.name, g]));
  const levels = Array.from({ length: 3 }, () => new Map<string, Finding | null>());

  function visit(name: string, depth: number, parent?: string): Finding | null {
    const group = groups.get(name);
    if (!group) {
      const proxy = proxies.get(name);
      if (
        parent &&
        proxy?.type === 'http' &&
        typeof proxy.port === 'number' &&
        onlyKeys(proxy, ['name', 'type', 'server', 'port'])
      )
        return null;
      return {
        reference: parent,
        reason: proxy
          ? '该节点协议、连接参数或直接指定节点的用法缺少导入后的出口对照。'
          : '该内置目标缺少导入后的出口对照。',
      };
    }
    const checked = levels[depth];
    if (!checked) return { reference: name, reason: '超过三层的策略组选择缺少出口对照。' };
    const previous = checked.get(name);
    if (previous !== undefined) return previous;
    const result = checkMembers(group, depth);
    checked.set(name, result);
    return result;
  }

  function checkMembers(group: Named, depth: number): Finding | null {
    const { name } = group;
    const atGroup = (reason: string) => ({ reference: name, reason });
    let members: string[];
    if (
      group.type === 'select' &&
      onlyKeys(group, ['name', 'type', 'proxies']) &&
      Array.isArray(group.proxies)
    ) {
      members = group.proxies;
    } else if (
      depth === 0 &&
      group.type === 'select' &&
      group['include-all-proxies'] === true &&
      group.filter === '^HK-' &&
      group['empty-fallback'] === 'REJECT' &&
      onlyKeys(group, ['name', 'type', 'include-all-proxies', 'filter', 'empty-fallback'])
    ) {
      members = [...proxies.keys()].filter((member) => member.startsWith('HK-'));
      if (!members.length)
        return atGroup('动态组零匹配时，原始 YAML 的 REJECT 回退尚未经真机验证。');
    } else {
      return atGroup('该策略组的类型、成员来源或组选项缺少导入后的出口对照。');
    }
    for (const member of members) {
      const finding = visit(member, depth + 1, name);
      if (finding) return { ...finding, reason: name + ' → ' + finding.reason };
    }
    return null;
  }
  return (target: string) => visit(target, 0);
}

// Plain ASCII DNS labels as in the exit probes. Other payload forms (e.g.
// wildcards, leading dots and Unicode) have their own matching semantics.
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function checkShadowrocketRules(content: string): ShadowrocketRuleIssue[] {
  const config: FinalConfig = parse(content);
  const checkTarget = targetChecker(config);
  const issues: ShadowrocketRuleIssue[] = [];
  for (const [index, raw] of (config.rules ?? []).entries()) {
    const refs = new Set<string>();
    const { type, target, params, payload } = parseAndValidateFinalRule(raw, false, 0, refs);
    const [reference] = refs;
    let finding: Finding | null;
    if (reference) {
      finding = {
        reference,
        reason:
          config['rule-providers']?.[reference]?.type === 'http'
            ? '规则集的远程正文可变，尚未核验手机下载的版本。'
            : '该规则集的正文与导入行为尚未核验。',
      };
    } else if (type === 'MATCH' && target === 'DIRECT') {
      finding = { reason: '尚无导入此 YAML 后未命中域名走直连的出口对照。' };
    } else if (type === 'PROCESS-NAME' || type === 'PROCESS-PATH') {
      finding = { reason: '尚未验证 iOS 导入此 YAML 后按进程名称或路径分流的行为。' };
    } else if (
      (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') &&
      !params.length &&
      DNS_NAME.test(payload) &&
      payload.length <= 253 &&
      raw === [type, payload, target].join(',')
    ) {
      finding =
        config.mode !== undefined && config.mode !== 'rule'
          ? { reason: '此运行模式下的规则选路尚未验证。' }
          : checkTarget(target);
    } else {
      finding = { reason: '该规则类型、匹配条件或参数缺少 Clash YAML 导入后的分流依据。' };
    }
    if (finding)
      issues.push({
        status: 'unverified',
        ruleNumber: index + 1,
        ruleType: type,
        target,
        ...finding,
      });
  }
  return issues;
}
