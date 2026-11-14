import type { Rule, RuleType } from '@/ui/data/types';

/* ─── rule type metadata ─────────────────────────────────────────────── */

export interface RuleTypeMeta {
  label: string;
  hint: string;
  placeholder: string;
  family: 'domain' | 'ip' | 'set' | 'geo' | 'port' | 'process' | 'other' | 'match';
  options?: boolean;
}

export const RULE_TYPES: Record<RuleType, RuleTypeMeta> = {
  'DOMAIN-SUFFIX': { label: '域名后缀', hint: '匹配这个域名和它的所有子域名', placeholder: 'google.com', family: 'domain' },
  DOMAIN: { label: '完整域名', hint: '只匹配这一个域名，不含子域名', placeholder: 'www.google.com', family: 'domain' },
  'DOMAIN-KEYWORD': { label: '域名关键字', hint: '域名里包含这段文字就匹配', placeholder: 'google', family: 'domain' },
  'DOMAIN-REGEX': { label: '域名正则', hint: '用正则表达式匹配域名（不区分大小写）', placeholder: '^.*\\.example\\.com$', family: 'domain' },
  'RULE-SET': { label: '规则集', hint: '引用规则集里的一整批规则', placeholder: '选择规则集', family: 'set', options: true },
  GEOSITE: { label: '站点分类', hint: 'GeoSite 数据库里的站点分类，如 cn、google', placeholder: 'cn', family: 'geo' },
  GEOIP: { label: 'IP 归属地', hint: '目标 IP 所在国家或地区代码，如 CN', placeholder: 'CN', family: 'geo', options: true },
  'IP-CIDR': { label: 'IPv4 段', hint: '目标 IP 落在这个网段内', placeholder: '192.168.0.0/16', family: 'ip', options: true },
  'IP-CIDR6': { label: 'IPv6 段', hint: '目标 IPv6 落在这个网段内', placeholder: '2001:db8::/32', family: 'ip', options: true },
  'IP-ASN': { label: 'ASN', hint: '目标 IP 所属的自治系统编号', placeholder: '13335', family: 'ip', options: true },
  'SRC-IP-CIDR': { label: '来源 IP 段', hint: '发起连接的设备 IP 在这个网段内', placeholder: '192.168.1.0/24', family: 'ip' },
  'DST-PORT': { label: '目标端口', hint: '目标端口，可用 80/443 或 1000-2000', placeholder: '443', family: 'port' },
  'SRC-PORT': { label: '来源端口', hint: '来源端口', placeholder: '7890', family: 'port' },
  'PROCESS-NAME': { label: '进程名', hint: '发起连接的程序名（桌面端）', placeholder: 'Telegram', family: 'process' },
  'PROCESS-PATH': { label: '进程路径', hint: '发起连接的程序完整路径', placeholder: '/Applications/Telegram.app/…', family: 'process' },
  NETWORK: { label: '网络协议', hint: 'TCP 或 UDP', placeholder: 'UDP', family: 'other' },
  MATCH: { label: '兜底', hint: '前面都没命中时的去向，必须是最后一条', placeholder: '', family: 'match' },
};

export const RULE_TYPE_ORDER = Object.keys(RULE_TYPES) as RuleType[];

/* ─── smart input → rule type ────────────────────────────────────────── */

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/i;

export interface Detected {
  type: RuleType;
  value: string;
  note?: string;
}

/** Guess the rule type for a pasted value (domain, URL, IP, CIDR, port, geosite:xx …). */
export function detectRule(raw: string): Detected | null {
  let value = raw.trim().replace(/[,，]+$/, '');
  if (!value) return null;

  // Already a full rule line: TYPE,value[,policy]
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length >= 2 && (RULE_TYPE_ORDER as string[]).includes(parts[0].toUpperCase())) {
    return { type: parts[0].toUpperCase() as RuleType, value: parts[1] };
  }

  const lower = value.toLowerCase();
  if (lower.startsWith('geosite:')) return { type: 'GEOSITE', value: value.slice(8) };
  if (lower.startsWith('geoip:')) return { type: 'GEOIP', value: value.slice(6).toUpperCase() };
  if (/^https?:\/\//i.test(value)) {
    try {
      const host = new URL(value).hostname.replace(/^www\./, '');
      return { type: 'DOMAIN-SUFFIX', value: host, note: '已从网址提取域名' };
    } catch {
      /* fall through */
    }
  }
  if (value.includes('/')) {
    const [ip, bits] = value.split('/');
    if (IPV4.test(ip) && /^\d{1,2}$/.test(bits) && Number(bits) <= 32) return { type: 'IP-CIDR', value };
    if (ip.includes(':') && /^\d{1,3}$/.test(bits) && Number(bits) <= 128) return { type: 'IP-CIDR6', value };
  }
  if (IPV4.test(value)) return { type: 'IP-CIDR', value: `${value}/32`, note: '单个 IP 按 /32 处理' };
  if (/^[0-9a-f:]+$/i.test(value) && value.includes(':') && value.split(':').length > 2) {
    return { type: 'IP-CIDR6', value: `${value}/128`, note: '单个 IP 按 /128 处理' };
  }
  if (/^:?\d{1,5}(?:[-/]\d{1,5})*$/.test(value)) return { type: 'DST-PORT', value: value.replace(/^:/, '') };
  if (/^(?:\*|\+)\./.test(value)) {
    value = value.slice(2);
    return { type: 'DOMAIN-SUFFIX', value };
  }
  if (DOMAIN_RE.test(value)) return { type: 'DOMAIN-SUFFIX', value: value.replace(/^www\./i, '') };
  if (/^[a-z0-9_-]+$/i.test(value)) return { type: 'DOMAIN-KEYWORD', value };
  if (/\.exe$/i.test(value)) return { type: 'PROCESS-NAME', value };
  return { type: 'DOMAIN-KEYWORD', value };
}

/* ─── ordering ───────────────────────────────────────────────────────── */

export const isActiveMatch = (rule: Pick<Rule, 'type' | 'enabled'>) => rule.type === 'MATCH' && rule.enabled !== false;

export function sortWithinAnchor(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => {
    const ta = isActiveMatch(a);
    const tb = isActiveMatch(b);
    if (ta !== tb) return ta ? 1 : -1;
    return a.rank - b.rank || a.id.localeCompare(b.id);
  });
}

export interface AnchorSection {
  anchor: string;
  known: boolean;
  rules: Rule[];
}

/** Rules in the order Mihomo evaluates them: anchors as they appear in the base, then rank. */
export function sectionize(rules: Rule[], anchors: string[]): AnchorSection[] {
  const byAnchor = new Map<string, Rule[]>();
  for (const rule of rules) {
    const list = byAnchor.get(rule.anchor) ?? [];
    list.push(rule);
    byAnchor.set(rule.anchor, list);
  }
  const sections: AnchorSection[] = anchors.map((anchor) => ({
    anchor,
    known: true,
    rules: sortWithinAnchor(byAnchor.get(anchor) ?? []),
  }));
  for (const [anchor, list] of byAnchor) {
    if (!anchors.includes(anchor)) sections.push({ anchor, known: false, rules: sortWithinAnchor(list) });
  }
  return sections;
}

export function ruleText(rule: Pick<Rule, 'type' | 'value' | 'policy' | 'options'>): string {
  if (rule.type === 'MATCH') return `MATCH,${rule.policy}`;
  return [rule.type, rule.value, rule.policy, ...(rule.options ?? [])].join(',');
}

/* ─── client-side matching for the route tester ──────────────────────── */

function ipv4ToInt(ip: string): number | null {
  if (!IPV4.test(ip)) return null;
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const target = ipv4ToInt(ip);
  const start = ipv4ToInt(base);
  if (target === null || start === null) return false;
  const bits = Number(bitsRaw ?? 32);
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (target & mask) === (start & mask);
}

export type MatchVerdict = 'match' | 'no' | 'unknown';

export interface Probe {
  host: string | null;
  ip: string | null;
}

export function parseProbe(input: string): Probe | null {
  let value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  value = value.replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
  if (IPV4.test(value)) return { host: null, ip: value };
  return { host: value, ip: null };
}

/** Domain-list entries as used by rule-set files: `+.x`, `.x`, `*.x`, `x`. */
export function domainEntryMatches(entry: string, host: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e || e.startsWith('#')) return false;
  if (e.startsWith('+.') || e.startsWith('.')) {
    const base = e.replace(/^\+?\./, '');
    return host === base || host.endsWith(`.${base}`);
  }
  if (e.startsWith('*.')) {
    const base = e.slice(2);
    return host.endsWith(`.${base}`) && host.split('.').length === base.split('.').length + 1;
  }
  return host === e;
}

export function evaluateRule(
  rule: Pick<Rule, 'type' | 'value'>,
  probe: Probe,
  ruleSetVerdict?: (name: string) => MatchVerdict,
): MatchVerdict {
  const value = rule.value.trim();
  const host = probe.host;
  switch (rule.type) {
    case 'MATCH':
      return 'match';
    case 'DOMAIN':
      return host ? (host === value.toLowerCase() ? 'match' : 'no') : 'no';
    case 'DOMAIN-SUFFIX': {
      if (!host) return 'no';
      const v = value.toLowerCase();
      return host === v || host.endsWith(`.${v}`) ? 'match' : 'no';
    }
    case 'DOMAIN-KEYWORD':
      return host ? (host.includes(value.toLowerCase()) ? 'match' : 'no') : 'no';
    case 'DOMAIN-REGEX':
      if (!host) return 'no';
      try {
        return new RegExp(value, 'i').test(host) ? 'match' : 'no';
      } catch {
        return 'unknown';
      }
    case 'IP-CIDR':
      // A domain is resolved by Mihomo unless no-resolve is set — the result depends on DNS.
      if (probe.ip) return ipv4InCidr(probe.ip, value) ? 'match' : 'no';
      return 'unknown';
    case 'IP-CIDR6':
    case 'IP-ASN':
    case 'GEOIP':
      return probe.ip && rule.type === 'IP-CIDR6' ? 'no' : 'unknown';
    case 'RULE-SET':
      return ruleSetVerdict ? ruleSetVerdict(value) : 'unknown';
    case 'GEOSITE':
      return host ? 'unknown' : 'no';
    case 'SRC-IP-CIDR':
    case 'SRC-PORT':
    case 'DST-PORT':
    case 'PROCESS-NAME':
    case 'PROCESS-PATH':
    case 'NETWORK':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** IP rules with no-resolve never trigger DNS for a domain → they cannot match a domain probe. */
export function evaluateWithOptions(
  rule: Pick<Rule, 'type' | 'value' | 'options'>,
  probe: Probe,
  ruleSetVerdict?: (name: string) => MatchVerdict,
): MatchVerdict {
  const noResolve = rule.options?.includes('no-resolve');
  if (probe.host && noResolve && ['IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'GEOIP'].includes(rule.type)) return 'no';
  return evaluateRule(rule, probe, ruleSetVerdict);
}

/** Evaluate a hosted rule-set body against a probe (domain / classical / ipcidr). */
export function evaluateRuleSetContent(content: string, behavior: string | undefined, probe: Probe): MatchVerdict {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, ''))
    .filter((l) => l && !l.startsWith('#') && l !== 'payload:');
  let unknown = false;
  for (const line of lines) {
    if (behavior === 'domain') {
      if (probe.host && domainEntryMatches(line, probe.host)) return 'match';
    } else if (behavior === 'ipcidr') {
      if (probe.ip && line.includes('.') && ipv4InCidr(probe.ip, line)) return 'match';
      if (!probe.ip) unknown = true;
    } else {
      const [type, value, ...rest] = line.split(',').map((p) => p.trim());
      if (!type || value === undefined) continue;
      const verdict = evaluateWithOptions({ type: type.toUpperCase() as RuleType, value, options: rest }, probe);
      if (verdict === 'match') return 'match';
      if (verdict === 'unknown') unknown = true;
    }
  }
  return unknown ? 'unknown' : 'no';
}
