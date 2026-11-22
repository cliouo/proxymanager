import { compileTemplate, formatNodeName, LINE_TAGS, recognizeName, type NodeRecognitionFacts } from './naming';
import { fieldValueSelector, renderRawNamingProbe, type CandidateNode } from './namingCandidates';
import { matchFilter } from './filterMatch';
import { REGIONS } from './regions';

export const GROUPING_PURPOSES = ['region', 'source', 'low-rate', 'dedicated', 'residential'] as const;
export type GroupingPurpose = typeof GROUPING_PURPOSES[number];
const LABELS: Record<GroupingPurpose, string> = { region: '地区', source: '机场/来源', 'low-rate': '低倍率', dedicated: '专线', residential: '家宽' };
const BUILTINS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', 'COMPATIBLE', 'GLOBAL'];
const DEDICATED = ['IEPL', 'IPLC', '专线'];
const identityOf = (node: CandidateNode) => JSON.stringify([node.sourceKey, node.identity]);
const recognizedFacts = new WeakMap<CandidateNode, { name: string; facts: NodeRecognitionFacts }>();
function factsOf(node: CandidateNode): NodeRecognitionFacts {
  if (node.facts) return node.facts;
  let cached = recognizedFacts.get(node);
  if (!cached || cached.name !== node.name) {
    const recognized = recognizeName(node.name, undefined, { detectInfo: false });
    cached = { name: node.name, facts: { region: recognized.region ?? undefined, tags: recognized.tags, rate: recognized.rate ?? undefined, vendor: recognized.vendor ?? undefined } };
    recognizedFacts.set(node, cached);
  }
  return cached.facts;
}

export interface GeneratedGroup {
  name: string;
  kind: 'filter' | 'single-sub' | 'manual';
  type: 'select';
  filter?: string;
  'include-all-proxies'?: boolean;
  bound_subscription_id?: string;
  proxies?: string[];
  count: number;
  sample: string[];
}

export interface GroupingPreview {
  configVersion: number;
  template: string;
  purposes: { id: GroupingPurpose; label: string; count: number; selected: boolean }[];
  profiles: { name: string; groups: GeneratedGroup[] }[];
  warnings: string[];
  blocked: boolean;
}

export function templateForGrouping(template: string, purposes: readonly GroupingPurpose[]) {
  const required = new Set(GROUPING_PURPOSES.filter((p) => purposes.includes(p)).map((p) => p === 'low-rate' ? 'rate' : p === 'dedicated' || p === 'residential' ? 'tags' : p));
  const fields = new Set<string>(compileTemplate(template).flatMap((t) => t.type === 'literal' ? [] : [t.field]));
  for (const field of required) {
    if (field === 'region' && (fields.has('region') || fields.has('region_code') || fields.has('emoji'))) continue;
    if (!fields.has(field)) template += '${?' + field + ': · ${' + field + '}}';
  }
  return template;
}

export function groupingCounts(nodes: CandidateNode[]) {
  return GROUPING_PURPOSES.map((id) => ({ id, label: LABELS[id], count: new Set(nodes.filter((node) => {
    const facts = factsOf(node);
    return id === 'region' ? !!facts.region : id === 'source' ? !!node.sourceKey : id === 'low-rate' ? facts.rate != null && facts.rate < 1
      : (facts.tags ?? []).some((t) => (id === 'dedicated' ? DEDICATED : ['家宽']).includes(t));
  }).map(identityOf)).size }));
}

function freshName(node: CandidateNode, template: string, changes: Partial<NodeRecognitionFacts> = {}, source = node.sourceLabel ?? node.sourceKey ?? '') {
  const facts = factsOf(node);
  if (node.namingTemplate === null) {
    const raw = { ...node, name: `${node.name} · fresh-node`, facts };
    const varied = { ...facts, ...changes };
    const state = { facts: { region: varied.region ?? null, tags: varied.tags ?? [], rate: varied.rate ?? null, vendor: varied.vendor ?? null }, sourceLabel: source };
    if (changes.region !== undefined) return renderRawNamingProbe(raw, 'region', state);
    if (changes.tags !== undefined) return renderRawNamingProbe(raw, 'tags', state);
    if (changes.rate !== undefined) return renderRawNamingProbe(raw, 'rate', state);
    if (source !== (node.sourceLabel ?? node.sourceKey ?? '')) return renderRawNamingProbe(raw, 'source', state);
    return raw.name;
  }
  return formatNodeName({ name: 'fresh-node', index: 999, type: node.type,
    source: { key: node.sourceKey ?? '', label: source }, config: { template: node.namingTemplate ?? template, tw2cn: node.namingTw2cn },
    facts: { ...facts, ...changes } });
}

export function generateNamingGroups(nodes: CandidateNode[], template: string, purposes: readonly GroupingPurpose[], reservedNames: string[] = []) {
  const used = new Set([...BUILTINS, ...reservedNames, ...nodes.map((n) => n.name)]);
  const groups: GeneratedGroup[] = [];
  const captured = new Set<string>();
  const warnings: string[] = [];
  const nameOf = (label: string) => {
    const base = label.trim().slice(0, 100) || '策略组';
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${base} (${suffix})`;
    used.add(name);
    return name;
  };
  const add = (label: string, intended: CandidateNode[], filters: string | string[], variants: (node: CandidateNode) => { name: string; expected: boolean }[], sourceId?: string) => {
    if (!intended.length) return;
    const ids = new Set(intended.map(identityOf));
    let probes: { name: string; expected: boolean }[] | undefined;
    const filter = (Array.isArray(filters) ? filters : [filters]).find((candidate) => {
      const matched = matchFilter(nodes.map((n) => n.name), candidate);
      const actual = new Set(matched.matched);
      if (candidate.length > 4096 || matched.error || !nodes.every((n) => actual.has(n.name) === ids.has(identityOf(n)))) return false;
      probes ??= intended.flatMap((n) => [{ name: freshName(n, template), expected: true }, ...variants(n)]);
      return probes.every((p) => {
        const result = matchFilter([p.name], candidate);
        return !result.error && !!result.matched.length === p.expected;
      });
    });
    const valid = filter !== undefined;
    if (!valid && !sourceId) { warnings.push(`「${label}」无法验证字段筛选，未生成。`); return; }
    for (const id of ids) captured.add(id);
    groups.push({ name: nameOf(label), type: 'select', ...(valid
      ? { kind: 'filter' as const, 'include-all-proxies': true, filter }
      : { kind: 'single-sub' as const, bound_subscription_id: sourceId }),
    count: intended.length, sample: intended.slice(0, 3).map((n) => n.name) });
  };
  for (const purpose of GROUPING_PURPOSES.filter((p) => purposes.includes(p))) {
    if (purpose === 'region') for (const region of REGIONS) {
      const intended = nodes.filter((n) => factsOf(n).region === region.code);
      const tokens = [region.zh, region.code, region.emoji].filter((token) => intended.some((n) => matchFilter([n.name], fieldValueSelector([token])).matched.length));
      const selectors = [tokens.filter((t) => t !== region.emoji), ...tokens.map((t) => [t]),
        ...tokens.map((_, i) => tokens.filter((_, j) => i !== j)), tokens].filter((values) => values.length).map(fieldValueSelector);
      add(`${region.emoji} ${region.zh}`, intended, [...new Set(selectors)], (n) => REGIONS.map((other) => ({ name: freshName(n, template, { region: other.code }), expected: other.code === region.code })));
    } else if (purpose === 'source') for (const key of [...new Set(nodes.flatMap((n) => n.sourceKey ? [n.sourceKey] : []))]) {
      const intended = nodes.filter((n) => n.sourceKey === key);
      const tokens = intended.map((n) => n.sourceLabel ?? key);
      add(tokens[0], intended, fieldValueSelector(tokens), (n) => [{ name: freshName(n, template, {}, 'probe-other-provider'), expected: false }], intended[0].sourceId);
    } else if (purpose === 'low-rate') {
      add('低倍率', nodes.filter((n) => { const rate = factsOf(n).rate; return rate != null && rate < 1; }),
        '(?<![A-Za-z0-9.])0(?:\\.[0-9]+)?x(?![A-Za-z0-9.])',
        (n) => [0.25, 0.5, 1, 2].map((rate) => ({ name: freshName(n, template, { rate }), expected: rate < 1 })));
    } else {
      const tags = purpose === 'dedicated' ? DEDICATED : ['家宽'];
      add(LABELS[purpose], nodes.filter((n) => (factsOf(n).tags ?? []).some((t) => tags.includes(t))), fieldValueSelector(tags),
        (n) => [[], ...LINE_TAGS.map((tag) => [tag])].map((value) => ({ name: freshName(n, template, { tags: value }), expected: value.some((tag) => tags.includes(tag)) })));
    }
  }
  if (groups.length) groups.unshift({ name: nameOf('节点选择'), kind: 'manual', type: 'select', proxies: [...groups.map((g) => g.name), 'DIRECT'],
    count: captured.size, sample: nodes.filter((n) => captured.has(identityOf(n))).slice(0, 3).map((n) => n.name) });
  return { groups, warnings, blocked: warnings.length > 0 || groups.length === 0 };
}
