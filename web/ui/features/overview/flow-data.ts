import type { ProxyGroup, Rule } from '@/ui/data/types';
import type { FlowLink, FlowNode } from '@/ui/viz/sankey';
import { BUILTIN_LABEL, isBuiltinPolicy } from '@/ui/viz/lines';

/** How a rule type reads in the flow map. RULE-SETs are listed by name. */
const CATEGORY: Record<string, { id: string; label: string }> = {
  DOMAIN: { id: 'cat:domain', label: '域名' },
  'DOMAIN-SUFFIX': { id: 'cat:domain', label: '域名' },
  'DOMAIN-KEYWORD': { id: 'cat:domain', label: '域名' },
  'DOMAIN-REGEX': { id: 'cat:domain', label: '域名' },
  'IP-CIDR': { id: 'cat:ip', label: 'IP 段' },
  'IP-CIDR6': { id: 'cat:ip', label: 'IP 段' },
  'IP-ASN': { id: 'cat:ip', label: 'IP 段' },
  'SRC-IP-CIDR': { id: 'cat:ip', label: 'IP 段' },
  GEOIP: { id: 'cat:geo', label: '地理位置库' },
  GEOSITE: { id: 'cat:geo', label: '地理位置库' },
  'PROCESS-NAME': { id: 'cat:process', label: '进程' },
  'PROCESS-PATH': { id: 'cat:process', label: '进程' },
  'DST-PORT': { id: 'cat:port', label: '端口与协议' },
  'SRC-PORT': { id: 'cat:port', label: '端口与协议' },
  NETWORK: { id: 'cat:port', label: '端口与协议' },
  MATCH: { id: 'cat:match', label: '兜底 MATCH' },
};

const MAX_RULESET_NODES = 7;

export interface FlowData {
  left: FlowNode[];
  right: FlowNode[];
  links: FlowLink[];
  total: number;
}

export function buildFlow(rules: Rule[], groups: ProxyGroup[], color: (policy: string) => string): FlowData {
  const active = rules.filter((r) => r.enabled !== false);
  const ruleSetCounts = new Map<string, number>();
  for (const rule of active) {
    if (rule.type === 'RULE-SET') ruleSetCounts.set(rule.value, (ruleSetCounts.get(rule.value) ?? 0) + 1);
  }
  // Keep the largest rule-sets as their own nodes; fold the tail into one.
  const keptSets = new Set(
    [...ruleSetCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_RULESET_NODES)
      .map(([name]) => name),
  );

  const leftMeta = new Map<string, FlowNode>();
  const linkMap = new Map<string, number>();
  for (const rule of active) {
    let node: FlowNode;
    if (rule.type === 'RULE-SET') {
      node = keptSets.has(rule.value)
        ? { id: `set:${rule.value}`, label: rule.value, sublabel: '规则集' }
        : { id: 'set:__rest', label: '其他规则集', sublabel: '规则集' };
    } else {
      const cat = CATEGORY[rule.type] ?? { id: 'cat:other', label: '其他' };
      node = { id: cat.id, label: cat.label };
    }
    leftMeta.set(node.id, node);
    const key = `${node.id}\u0000${rule.policy}`;
    linkMap.set(key, (linkMap.get(key) ?? 0) + 1);
  }

  const leftOrder = (id: string) =>
    id.startsWith('set:') ? (id === 'set:__rest' ? 1 : 0) : id === 'cat:match' ? 9 : 2;
  const left = [...leftMeta.values()].sort((a, b) => leftOrder(a.id) - leftOrder(b.id));

  const groupRank = new Map(groups.map((g) => [g.name, g.rank]));
  const policies = new Set([...linkMap.keys()].map((k) => k.split('\u0000')[1]));
  const right: FlowNode[] = [...policies]
    .sort((a, b) => {
      const ra = groupRank.get(a);
      const rb = groupRank.get(b);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.localeCompare(b);
    })
    .map((policy) => ({
      id: policy,
      label: policy,
      color: color(policy),
      sublabel: isBuiltinPolicy(policy) ? BUILTIN_LABEL[policy] : undefined,
    }));

  const links: FlowLink[] = [...linkMap.entries()].map(([key, value]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, value };
  });

  return { left, right, links, total: active.length };
}
