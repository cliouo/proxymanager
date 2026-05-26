import { createHash } from 'node:crypto';
import type { Rule } from '@/schemas';

export interface AnchorStats {
  anchor: string;
  ruleCount: number;
}

export interface RenderResult {
  content: string;
  buildId: string;
  anchorsApplied: AnchorStats[];
  unmatchedAnchors: string[];
}

const ANCHOR_LINE_PATTERN = /^([ \t]*)#\s*===\s*ANCHOR:\s*([\w-]+)\s*===\s*$/gm;

export function renderRule(rule: Rule): string {
  if (rule.type === 'MATCH') return `MATCH,${rule.policy}`;
  const modifiers = rule.options?.length ? `,${rule.options.join(',')}` : '';
  return `${rule.type},${rule.value},${rule.policy}${modifiers}`;
}

export function groupRulesByAnchor(rules: Rule[]): Map<string, Rule[]> {
  const byAnchor = new Map<string, Rule[]>();
  for (const rule of rules) {
    const list = byAnchor.get(rule.anchor) ?? [];
    list.push(rule);
    byAnchor.set(rule.anchor, list);
  }
  for (const list of byAnchor.values()) {
    list.sort((a, b) => a.rank - b.rank);
  }
  return byAnchor;
}

export function renderBase(baseContent: string, rules: Rule[]): RenderResult {
  // Parked rules (enabled === false) stay in the hash but never reach the
  // rendered config. Legacy rules have no `enabled` field and render normally.
  const active = rules.filter((rule) => rule.enabled !== false);
  const byAnchor = groupRulesByAnchor(active);
  const seenAnchors = new Set<string>();
  const stats: AnchorStats[] = [];

  const content = baseContent.replace(ANCHOR_LINE_PATTERN, (line, indent: string, name: string) => {
    seenAnchors.add(name);
    const matched = byAnchor.get(name);
    if (!matched || matched.length === 0) {
      stats.push({ anchor: name, ruleCount: 0 });
      return line;
    }
    stats.push({ anchor: name, ruleCount: matched.length });
    const rendered = matched.map((r) => `${indent}- ${renderRule(r)}`).join('\n');
    return `${line}\n${rendered}`;
  });

  const unmatchedAnchors: string[] = [];
  for (const anchor of byAnchor.keys()) {
    if (!seenAnchors.has(anchor)) unmatchedAnchors.push(anchor);
  }

  const buildId = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);

  return { content, buildId, anchorsApplied: stats, unmatchedAnchors };
}
