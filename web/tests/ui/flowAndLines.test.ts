import { describe, expect, it } from 'vitest';
import type { ProxyGroup, Rule } from '@/schemas';
import { buildFlow } from '@/ui/features/overview/flow-data';
import { assignLineColors, LINE_COUNT, policyColor } from '@/ui/viz/lines';

function rule(type: Rule['type'], value: string, policy: string, enabled = true): Rule {
  return {
    id: `${type}-${value}-${policy}`,
    anchor: 'manual',
    type,
    value,
    policy,
    rank: 10,
    source: 'manual',
    added_at: 0,
    updated_at: 0,
    ...(enabled ? {} : { enabled: false }),
  } as Rule;
}

function group(name: string, rank: number): ProxyGroup {
  return { id: `id-${name}`, name, rank, kind: 'manual', type: 'select', updated_at: 0 } as ProxyGroup;
}

describe('buildFlow — overview flow map data', () => {
  const color = (policy: string) => `c(${policy})`;

  it('groups rule types into categories, lists rule-sets by name and drops disabled rules', () => {
    const flow = buildFlow(
      [
        rule('DOMAIN-SUFFIX', 'google.com', '节点选择'),
        rule('DOMAIN-KEYWORD', 'gemini', 'AI'),
        rule('RULE-SET', 'openai', 'AI'),
        rule('IP-CIDR', '10.0.0.0/8', 'DIRECT'),
        rule('GEOIP', 'CN', 'DIRECT'),
        rule('DOMAIN', 'off.example', 'AI', false),
        rule('MATCH', '', '默认'),
      ],
      [group('默认', 1), group('节点选择', 2), group('AI', 3)],
      color,
    );
    expect(flow.total).toBe(6);
    expect(flow.left.map((n) => n.id)).toEqual(['set:openai', 'cat:domain', 'cat:ip', 'cat:geo', 'cat:match']);
    // groups follow their rank, built-ins come after
    expect(flow.right.map((n) => n.id)).toEqual(['默认', '节点选择', 'AI', 'DIRECT']);
    expect(flow.right.find((n) => n.id === 'DIRECT')?.sublabel).toBe('直连');
    expect(flow.links).toContainEqual({ from: 'cat:domain', to: 'AI', value: 1 });
    expect(flow.links).toContainEqual({ from: 'cat:domain', to: '节点选择', value: 1 });
    expect(flow.right[0].color).toBe('c(默认)');
  });

  it('folds the long tail of rule-sets into one node', () => {
    const rules = Array.from({ length: 10 }, (_, i) => rule('RULE-SET', `set-${i}`, 'P'));
    const flow = buildFlow(rules, [group('P', 1)], color);
    expect(flow.left.filter((n) => n.id.startsWith('set:') && n.id !== 'set:__rest')).toHaveLength(7);
    expect(flow.links.find((l) => l.from === 'set:__rest')?.value).toBe(3);
  });
});

describe('assignLineColors — transit line palette', () => {
  it('gives the first LINE_COUNT groups distinct colours', () => {
    const names = Array.from({ length: LINE_COUNT }, (_, i) => `group-${i}`);
    const colours = new Set(assignLineColors(names).values());
    expect(colours.size).toBe(LINE_COUNT);
  });

  it('keeps existing colours when a group is appended', () => {
    const before = assignLineColors(['入口', '流媒体', 'AI 服务']);
    const after = assignLineColors(['入口', '流媒体', 'AI 服务', '新组']);
    for (const [name, colour] of before) expect(after.get(name)).toBe(colour);
  });

  it('paints built-in policies with the neutral direct / reject lines', () => {
    const map = assignLineColors(['A']);
    expect(policyColor(map, 'DIRECT')).toBe('var(--l-direct)');
    expect(policyColor(map, 'REJECT')).toBe('var(--l-reject)');
    expect(policyColor(map, 'unknown-policy')).toBe('var(--ink-4)');
  });
});
