import { parse } from 'yaml';
import { collectActiveTunRuleSetReferences, parseAndValidateFinalRule } from './resolve';

export interface ShadowrocketRuleIssue {
  status: 'incompatible' | 'unverified';
  reason: string;
  /** One-based position inside the effective rule table (top level or a sub-rule table). */
  ruleNumber?: number;
  ruleType?: string;
  target?: string;
  reference?: string;
  /** Listener whose `rule` selects a sub-rule table. */
  listener?: string;
  /** Selected `sub-rules` table name. */
  table?: string;
  /** Group member selected by a rule target, when the finding is about that member. */
  member?: string;
  /** Only the protocol/option keys that need evidence, never their values. */
  option?: string;
  /** Active TUN route-set field that references `setName`. */
  field?: string;
  setName?: string;
  /** Effective running mode when a mode-level route lacks evidence. */
  mode?: string;
}

// Input is the final YAML accepted by the device renderer. Its names are unique,
// its select graph is acyclic, and all explicit members and rule targets resolve.
type Named = { name: string; type: string; [key: string]: unknown };
interface FinalConfig {
  mode?: unknown;
  tun?: unknown;
  listeners?: unknown;
  proxies?: Named[];
  'proxy-groups'?: Named[];
  'rule-providers'?: Record<string, { type?: string }>;
  rules?: string[];
  'sub-rules'?: unknown;
}
type Finding = Pick<ShadowrocketRuleIssue, 'reason' | 'reference' | 'member' | 'option'>;
type RuleContext = Pick<ShadowrocketRuleIssue, 'listener' | 'table'>;

const PROXY_KEYS = ['name', 'type', 'server', 'port'];
const GROUP_KEYS = ['name', 'type', 'proxies'];

const onlyKeys = (entry: Named, allowed: string[]) =>
  Object.keys(entry).every((key) => allowed.includes(key));

function keyList(entry: Named, allowed: string[]): string[] {
  return Object.keys(entry).filter((key) => !allowed.includes(key));
}

function typeKey(entry: Named): string {
  return typeof entry.type === 'string' ? `type=${entry.type}` : 'type';
}

function proxyFinding(proxy: Named, parent?: string): Finding {
  const option = [
    ...(proxy.type === 'http'
      ? typeof proxy.port === 'number'
        ? []
        : ['port']
      : [typeKey(proxy)]),
    ...keyList(proxy, PROXY_KEYS),
  ].join(',');
  return {
    reference: parent,
    member: proxy.name,
    option: option || '连接参数',
    reason:
      (parent ? `成员 ${proxy.name}` : `直接指定节点 ${proxy.name}`) +
      `（${option || '连接参数'}）缺少导入后的出口对照。`,
  };
}

function groupFinding(group: Named): Finding {
  const option =
    group.type === 'select' && Array.isArray(group.proxies)
      ? keyList(group, GROUP_KEYS).join(',')
      : group.type === 'select'
        ? 'proxies'
        : typeKey(group);
  return {
    reference: group.name,
    option: option || 'type',
    reason: `组选项 ${option || 'type'} 缺少导入后的出口对照。`,
  };
}

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
        onlyKeys(proxy, PROXY_KEYS)
      )
        return null;
      if (proxy) return proxyFinding(proxy, parent);
      return {
        reference: parent,
        reason: parent
          ? `策略组 ${parent} 中找不到成员 ${name}。`
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
    let members: string[];
    if (group.type === 'select' && onlyKeys(group, GROUP_KEYS) && Array.isArray(group.proxies)) {
      members = group.proxies as string[];
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
        return {
          reference: name,
          option: 'empty-fallback',
          reason: '动态组零匹配时，原始 YAML 的 REJECT 回退尚未经真机验证。',
        };
    } else {
      return groupFinding(group);
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

function listenerLabel(listener: Record<string, unknown>, index: number): string {
  const name = listener.name;
  return typeof name === 'string' && name.trim() !== '' ? name : `listeners[${index}]`;
}

function ruleTables(
  config: FinalConfig,
): Array<{ context: RuleContext; rules: string[]; missing?: boolean }> {
  const tables: Array<{ context: RuleContext; rules: string[]; missing?: boolean }> = [
    { context: {}, rules: Array.isArray(config.rules) ? config.rules : [] },
  ];
  const subRules =
    config['sub-rules'] &&
    typeof config['sub-rules'] === 'object' &&
    !Array.isArray(config['sub-rules'])
      ? (config['sub-rules'] as Record<string, unknown>)
      : {};
  const listeners = Array.isArray(config.listeners) ? config.listeners : [];
  for (const [index, rawListener] of listeners.entries()) {
    if (!rawListener || typeof rawListener !== 'object' || Array.isArray(rawListener)) continue;
    const listener = rawListener as Record<string, unknown>;
    if (typeof listener.rule !== 'string' || listener.rule === '') continue;
    const context = { listener: listenerLabel(listener, index), table: listener.rule };
    const body = subRules[listener.rule];
    if (!Array.isArray(body) || body.some((rule) => typeof rule !== 'string')) {
      tables.push({ context, rules: [], missing: true });
    } else {
      tables.push({ context, rules: body as string[] });
    }
  }
  return tables;
}

function checkRule(
  raw: string,
  index: number,
  context: RuleContext,
  config: FinalConfig,
  checkTarget: (target: string) => Finding | null,
): ShadowrocketRuleIssue | null {
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
    finding = checkTarget(target);
  } else {
    finding = { reason: '该规则类型、匹配条件或参数缺少 Clash YAML 导入后的分流依据。' };
  }
  if (!finding) return null;
  return {
    status: 'unverified',
    ruleNumber: index + 1,
    ruleType: type,
    target,
    ...context,
    ...finding,
  };
}

function modeOf(config: FinalConfig): 'rule' | 'global' | 'direct' | null {
  if (config.mode === undefined || config.mode === null) return 'rule';
  if (config.mode === 'rule' || config.mode === 'global' || config.mode === 'direct') {
    return config.mode;
  }
  return null;
}

function tunIssues(config: FinalConfig): ShadowrocketRuleIssue[] {
  const references = [...collectActiveTunRuleSetReferences(config.tun, true)];
  if (Array.isArray(config.listeners)) {
    for (const rawListener of config.listeners) {
      if (
        rawListener &&
        typeof rawListener === 'object' &&
        !Array.isArray(rawListener) &&
        (rawListener as Record<string, unknown>).type === 'tun'
      ) {
        references.push(...collectActiveTunRuleSetReferences(rawListener, false));
      }
    }
  }
  const seen = new Set<string>();
  const issues: ShadowrocketRuleIssue[] = [];
  for (const { field, name } of references) {
    const key = field + '\0' + name;
    if (seen.has(key)) continue;
    seen.add(key);
    const provider = config['rule-providers']?.[name];
    issues.push({
      status: 'unverified',
      field,
      setName: name,
      reference: name,
      reason:
        provider?.type === 'http'
          ? `TUN 字段 ${field} 引用的远程规则集 ${name} 正文可变，尚未核验手机下载的版本。`
          : `TUN 字段 ${field} 引用的规则集 ${name} 正文与导入行为尚未核验。`,
    });
  }
  return issues;
}

export function checkShadowrocketRules(content: string): ShadowrocketRuleIssue[] {
  const config = parse(content) as FinalConfig | null;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const checkTarget = targetChecker(config);
  const mode = modeOf(config);
  const issues: ShadowrocketRuleIssue[] = [];

  if (mode === null) {
    const raw = config.mode;
    const label = typeof raw === 'string' ? raw : String(raw);
    issues.push({
      status: 'unverified',
      mode: label,
      reason: `运行模式 ${label} 的选路行为缺少导入后的依据。`,
    });
  } else if (mode === 'global') {
    const finding = checkTarget('GLOBAL');
    if (finding) {
      issues.push({
        status: 'unverified',
        mode,
        reference: finding.reference ?? 'GLOBAL',
        ...(finding.member !== undefined ? { member: finding.member } : {}),
        ...(finding.option !== undefined ? { option: finding.option } : {}),
        reason: `全局选路（mode: global → GLOBAL）缺少出口对照：${finding.reason}`,
      });
    }
  } else if (mode === 'direct') {
    issues.push({
      status: 'unverified',
      mode,
      reference: 'DIRECT',
      reason: '运行模式 direct 的直连行为缺少导入后的出口对照。',
    });
  } else {
    for (const table of ruleTables(config)) {
      if (table.missing) {
        issues.push({
          status: 'unverified',
          ...table.context,
          reason: `监听器选用的子规则表 ${table.context.table} 未声明，实际分流缺少依据。`,
        });
        continue;
      }
      for (const [index, raw] of table.rules.entries()) {
        const issue = checkRule(raw, index, table.context, config, checkTarget);
        if (issue) issues.push(issue);
      }
    }
  }

  issues.push(...tunIssues(config));
  return issues;
}
