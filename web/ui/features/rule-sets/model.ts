import type { Rule, RuleSet, RuleSetListItem } from '@/ui/data/types';

export type Source = 'local' | 'remote';
export type Format = 'yaml' | 'text' | 'mrs';
export type Behavior = 'classical' | 'domain' | 'ipcidr';

export const NAME_RE = /^[a-z0-9_-]+$/;

export const SOURCE_LABEL: Record<Source, string> = { local: '本地托管', remote: '远程' };

export const BEHAVIOR_META: Record<Behavior, { label: string; hint: string }> = {
  classical: { label: '经典', hint: '每行一条完整规则，如 DOMAIN-SUFFIX,google.com' },
  domain: { label: '域名', hint: '每行一个域名，+. 开头同时匹配子域名' },
  ipcidr: { label: 'IP 段', hint: '每行一个网段，如 10.0.0.0/8' },
};

export const FORMAT_META: Record<Format, string> = {
  text: '纯文本，每行一条',
  yaml: 'YAML，payload: 列表',
  mrs: 'mihomo 二进制规则集',
};

export const sourceOf = (set: Pick<RuleSet, 'source'>): Source => set.source ?? 'local';

export function formatInterval(seconds: number | undefined): string {
  if (!seconds) return '每天';
  if (seconds % 86_400 === 0) return seconds === 86_400 ? '每天' : `每 ${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? '每小时' : `每 ${seconds / 3_600} 小时`;
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}

export const INTERVAL_PRESETS = [
  { label: '1 小时', value: 3_600 },
  { label: '6 小时', value: 21_600 },
  { label: '1 天', value: 86_400 },
  { label: '7 天', value: 604_800 },
];

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface Usage {
  active: Rule[];
  disabled: Rule[];
  inBase: boolean;
  /** Written into the active profile's final config. */
  injected: boolean;
}

export function usageMap(sets: RuleSetListItem[], rules: Rule[] | undefined): Map<string, Usage> {
  const map = new Map<string, Usage>();
  for (const set of sets) {
    map.set(set.name, { active: [], disabled: [], inBase: set.referenced_in_base, injected: set.referenced_in_base });
  }
  for (const rule of rules ?? []) {
    if (rule.type !== 'RULE-SET') continue;
    const usage = map.get(rule.value);
    if (!usage) continue;
    if (rule.enabled === false) usage.disabled.push(rule);
    else {
      usage.active.push(rule);
      usage.injected = true;
    }
  }
  return map;
}

export function usageText(usage: Usage | undefined): string {
  if (!usage) return '…';
  const parts: string[] = [];
  if (usage.active.length) parts.push(`${usage.active.length} 条规则`);
  if (usage.inBase) parts.push('基础配置引用');
  if (!parts.length && usage.disabled.length) parts.push(`仅 ${usage.disabled.length} 条停用的规则`);
  return parts.length ? parts.join(' · ') : '未使用';
}

/** Non-empty, non-comment entries (ignores the YAML `payload:` header). */
export function countEntries(content: string): number {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l !== 'payload:').length;
}

export function contentPlaceholder(format: Format, behavior: Behavior): string {
  const lines =
    behavior === 'domain'
      ? ['+.example.com', 'api.example.org']
      : behavior === 'ipcidr'
        ? ['10.0.0.0/8', '192.168.0.0/16']
        : ['DOMAIN-SUFFIX,example.com', 'IP-CIDR,10.0.0.0/8,no-resolve'];
  return format === 'yaml' ? `payload:\n${lines.map((l) => `  - '${l}'`).join('\n')}` : lines.join('\n');
}
