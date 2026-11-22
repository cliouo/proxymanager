import { matchFilter } from './filterMatch';
import { defaultTemplateFor, formatNodeName, formatRate, recognizeName, type NodeRecognitionFacts } from './naming';
import { REGIONS, regionByCode } from './regions';

export interface CandidateNode {
  identity: string;
  name: string;
  type: string;
  scoped: boolean;
  sourceKey?: string;
  sourceLabel?: string;
  dialer?: string;
}

export interface CandidateGroup {
  id: string;
  name: string;
  values: Record<string, unknown>;
  boundSourceKeys?: string[];
}

export interface CandidateProfile {
  id: string;
  name: string;
  groups: CandidateGroup[];
  rules: { id: string; policy: string; enabled?: boolean }[];
  before: CandidateNode[];
  after: CandidateNode[];
  extraRefs?: { owner: string; name: string }[];
}

export interface CandidateGroupImpact {
  profileId: string;
  profileName: string;
  groupId: string;
  groupName: string;
  before: number;
  after: number;
  emptied: boolean;
  broken?: boolean;
  error?: string;
  migration?: { filter: string; after: number };
}

export interface CandidateReference {
  profileId: string;
  kind: 'manual' | 'rule' | 'dialer' | 'fallback';
  owner: string;
  before: string;
  after?: string;
  blocked: boolean;
}

export interface NamingCandidate {
  id: string;
  title: string;
  template: string;
  sample: string[];
  groups: CandidateGroupImpact[];
  emptiedGroups: CandidateGroupImpact[];
  references: CandidateReference[];
  warnings: string[];
  blocked: boolean;
}

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((v): v is string => typeof v === 'string') : [];

function adapterType(type: string): string {
  return ({ ss: 'shadowsocks', ssr: 'shadowsocksr' } as Record<string, string>)[type]
    ?? type.toLowerCase().replaceAll('-', '');
}

export function groupNodeMembers(group: CandidateGroup, nodes: CandidateNode[], filter?: string) {
  const v = group.values;
  const dynamic = v['include-all'] === true || v['include-all-proxies'] === true;
  const bound = group.boundSourceKeys && new Set(group.boundSourceKeys);
  const eligible = dynamic ? nodes : [];
  const excludeFilter = typeof v['exclude-filter'] === 'string' ? v['exclude-filter'] : undefined;
  const matched = matchFilter(eligible.map((n) => n.name),
    filter ?? (typeof v.filter === 'string' ? v.filter : undefined),
    excludeFilter);
  const explicit = matchFilter(bound ? nodes.filter((n) => bound.has(n.sourceKey ?? '')).map((n) => n.name) : strings(v.proxies),
    undefined, excludeFilter);
  const excluded = new Set((typeof v['exclude-type'] === 'string' ? v['exclude-type'].split('|') : strings(v['exclude-type'])).map((t) => t.toLowerCase()));
  const memberTypes = new Map([
    ['DIRECT', 'direct'], ['REJECT', 'reject'], ['REJECT-DROP', 'rejectdrop'], ['COMPATIBLE', 'compatible'],
    ['PASS', 'pass'], ['PASS-RULE', 'passrule'],
    ...nodes.map((n): [string, string] => [n.name, adapterType(n.type)]),
  ]);
  const members = new Set([...explicit.matched, ...matched.matched].filter((name) => !excluded.has(memberTypes.get(name) ?? '')));
  const selectedNodes = nodes.filter((node) => members.has(node.name));
  if (!members.size && typeof v['empty-fallback'] === 'string') members.add(v['empty-fallback']);
  return {
    nodes: nodes.filter((node) => members.has(node.name)),
    selectedNodes,
    error: matched.error ?? explicit.error,
  };
}

function selectorDependencies(nodes: CandidateNode[], groups: CandidateGroup[]) {
  const selectors = groups.flatMap((g) => [g.values.filter, g.values['exclude-filter']])
    .filter((s): s is string => typeof s === 'string').join(' ');
  const has = (value: string) => value !== '' && selectors.toLowerCase().includes(value.toLowerCase());
  const recognized = nodes.map((node) => recognizeName(node.name));
  const region = REGIONS.some((r) => [r.zh, r.emoji].some(has) ||
    [r.code, r.alpha3].some((code) => new RegExp(`(?:^|[^a-z])${code}(?:$|[^a-z])`, 'i').test(selectors)));
  const tags = /IEPL|IPLC|专线|家宽|家庭宽带|BGP|原生|native/i.test(selectors);
  const rate = /倍率|倍|rate|[x×].*(?:\d|\\d)|(?:\d|\\d).*[x×]/i.test(selectors);
  const source = nodes.some((n) => [n.sourceKey, n.sourceLabel].some((value) => has(value ?? ''))) || /source|来源|机场/i.test(selectors);
  const vendor = /vendor|商家/i.test(selectors) || recognized.some((r) => has(r.vendor ?? ''));
  return { region, tags, rate, source, vendor };
}

export function inferNamingTemplates(nodes: CandidateNode[], groups: CandidateGroup[], aggregate: boolean) {
  const { region, tags, rate, source, vendor } = selectorDependencies(nodes, groups);
  const rateField = rate ? '${?rate: · ${rate:include1x}}' : '';
  const sourceField = source ? '${?source: · ${source}}' : '';
  const vendorField = vendor ? '${?vendor: · ${vendor}}' : '';
  const regionField = region ? ' ${region_code}' : '';
  const fields = [region || !groups.some((g) => g.values.filter || g.values['exclude-filter']) ? '${emoji} ${region} ${region_code}' : '${region}',
    tags ? '${?tags: · ${tags}}' : '', rateField,
    sourceField, vendorField,
    '${?note: · ${note}}', ' · ${index}'];
  const templates = [
    { id: 'preserve', title: '保持策略组可用', template: fields.join('') },
    { id: 'recommended', title: '推荐命名 · 线路标签', template: defaultTemplateFor(aggregate).replace('${rate}', rate ? '${rate:include1x}' : '${rate}') + regionField + '${?tags: · ${tags}}' + vendorField + (!aggregate ? sourceField : '') },
    { id: 'compact', title: '精简命名', template: '${region_code} ${index}${?tags: · ${tags}}' + rateField + sourceField + vendorField },
  ];
  return templates.filter((item, i) => templates.findIndex((other) => other.template === item.template) === i);
}

function sameSet(a: CandidateNode[], b: CandidateNode[]) {
  const left = new Set(a.map((n) => n.identity));
  const right = new Set(b.map((n) => n.identity));
  return left.size === right.size && [...left].every((id) => right.has(id));
}

const escapeRegex = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type SelectorField = keyof ReturnType<typeof selectorDependencies>;

function fieldValues(node: CandidateNode) {
  const recognized = recognizeName(node.name);
  const region = recognized.region ? regionByCode(recognized.region) : undefined;
  return {
    region: region ? [region.zh, region.code, region.emoji] : [],
    tags: recognized.tags,
    rate: recognized.rate === null ? [] : [formatRate(recognized.rate)],
    source: [node.sourceLabel ?? node.sourceKey].filter((s): s is string => !!s),
    vendor: recognized.vendor ? [recognized.vendor] : [],
  };
}

function tokenSelector(token: string) {
  return `${/^[A-Za-z0-9.]/.test(token) ? '(?<![A-Za-z0-9.])' : ''}${escapeRegex(token)}${/[A-Za-z0-9.]$/.test(token) ? '(?![A-Za-z0-9.])' : ''}`;
}

function freshFieldProbe(node: CandidateNode, fields: SelectorField[], template: string) {
  const recognized = recognizeName(node.name);
  const facts: NodeRecognitionFacts = {};
  if (fields.includes('region') && recognized.region) facts.region = recognized.region;
  if (fields.includes('tags')) facts.tags = recognized.tags;
  if (fields.includes('rate') && recognized.rate !== null) facts.rate = recognized.rate;
  if (fields.includes('vendor') && recognized.vendor) facts.vendor = recognized.vendor;
  return formatNodeName({ name: 'fresh-node', index: 999, type: node.type, facts,
    source: fields.includes('source') ? { key: 'fresh-source', label: node.sourceLabel ?? node.sourceKey ?? '' } : undefined,
    config: { template } });
}

function migratedSelector(group: CandidateGroup, before: CandidateNode[], after: CandidateNode[], recovered: CandidateNode[], template: string) {
  const dependencies = selectorDependencies(before, [group]);
  const fields = (Object.keys(dependencies) as SelectorField[]).filter((field) => dependencies[field]);
  const selectors = fields.flatMap((field) => {
    const values = [...new Set(recovered.flatMap((node) => fieldValues(node)[field]
      .filter((value) => matchFilter([node.name], tokenSelector(value)).matched.length > 0)))];
    return values.length ? [{ field, selector: `(?:${values.map(tokenSelector).join('|')})` }] : [];
  });
  for (let size = 1; size <= selectors.length; size += 1) {
    for (let mask = 1; mask < 2 ** selectors.length; mask += 1) {
      const selected = selectors.filter((_, i) => mask & (1 << i));
      if (selected.length !== size) continue;
      const filter = selected.length === 1 ? selected[0].selector : selected.map((s) => `(?=.*${s.selector})`).join('');
      if (filter.length > 4096 || filter.includes('`')) continue;
      const migrated = groupNodeMembers(group, after, filter);
      if (migrated.error || !sameSet(recovered, migrated.selectedNodes)) continue;
      const probes = recovered.filter((n) => n.scoped).map((n) => freshFieldProbe(n, selected.map((s) => s.field), template));
      if (probes.every((name) => matchFilter([name], filter,
        typeof group.values['exclude-filter'] === 'string' ? group.values['exclude-filter'] : undefined).matched.length === 1)) {
        return { filter, after: migrated.nodes.length };
      }
    }
  }
}

export function analyzeNamingCandidate(
  template: { id: string; title: string; template: string },
  profiles: CandidateProfile[],
  sample: string[],
): NamingCandidate {
  const groups: CandidateGroupImpact[] = [];
  const references: CandidateReference[] = [];
  const warnings: string[] = [];
  for (const profile of profiles) {
    const scoped = profile.before.filter((n) => n.scoped);
    const beforeNameCounts = new Map<string, number>();
    const afterNameCounts = new Map<string, number>();
    const afterByIdentity = new Map<string, CandidateNode[]>();
    for (const node of profile.before) beforeNameCounts.set(node.name, (beforeNameCounts.get(node.name) ?? 0) + 1);
    for (const node of profile.after) {
      afterNameCounts.set(node.name, (afterNameCounts.get(node.name) ?? 0) + 1);
      const nodes = afterByIdentity.get(node.identity) ?? [];
      nodes.push(node);
      afterByIdentity.set(node.identity, nodes);
    }
    const afterNode = (identity: string) => {
      const nodes = afterByIdentity.get(identity);
      return nodes?.length === 1 ? nodes[0] : undefined;
    };
    const mapping = new Map<string, string | undefined>();
    for (const node of scoped) {
      const after = afterNode(node.identity);
      const next = after && afterNameCounts.get(after.name) === 1 ? after.name : undefined;
      mapping.set(node.name, beforeNameCounts.get(node.name) === 1 ? next : undefined);
    }
    const ref = (kind: CandidateReference['kind'], owner: string, name: string, writable = true) => {
      if (!mapping.has(name) || mapping.get(name) === name) return;
      const after = mapping.get(name);
      references.push({ profileId: profile.id, kind, owner, before: name, after,
        blocked: after === undefined || !writable });
    };
    for (const group of profile.groups) {
      if (!group.boundSourceKeys) for (const name of strings(group.values.proxies)) ref('manual', group.id, name);
      if (typeof group.values['empty-fallback'] === 'string') ref('fallback', group.id, group.values['empty-fallback']);
      if (typeof group.values['dialer-proxy'] === 'string') ref('dialer', group.id, group.values['dialer-proxy']);
      const before = groupNodeMembers(group, profile.before);
      const after = groupNodeMembers(group, profile.after);
      const impact: CandidateGroupImpact = { profileId: profile.id, profileName: profile.name,
        groupId: group.id, groupName: group.name, before: before.nodes.length, after: after.nodes.length,
        emptied: before.nodes.length > 0 && after.nodes.length === 0,
        ...(before.error || after.error ? { error: before.error || after.error || undefined } : {}) };
      const providerBacked = group.values['include-all'] === true || group.values['include-all-providers'] === true || strings(group.values.use).length > 0;
      if (providerBacked) warnings.push(`${profile.name} / ${group.name}: 外部 provider 成员不可观测，仅统计配置内节点，不自动迁移筛选。`);
      if (impact.error) warnings.push(`${profile.name} / ${group.name}: ${impact.error}`);
      const beforeScoped = before.selectedNodes.filter((n) => n.scoped);
      const afterScoped = after.selectedNodes.filter((n) => n.scoped);
      const afterIdentities = new Set(afterScoped.map((n) => n.identity));
      if (beforeScoped.some((n) => !afterIdentities.has(n.identity)) && !providerBacked && !impact.error && typeof group.values.filter === 'string') {
        const recovered = before.selectedNodes.map((n) => afterNode(n.identity));
        if (recovered.every((n): n is CandidateNode => n !== undefined)) {
          impact.migration = migratedSelector(group, before.selectedNodes, profile.after, recovered, template.template);
        }
        impact.broken = !impact.migration;
      }
      groups.push(impact);
    }
    for (const rule of profile.rules) {
      if (rule.enabled !== false || mapping.get(rule.policy) !== undefined) ref('rule', rule.id, rule.policy);
    }
    for (const node of profile.before) if (node.dialer) {
      const after = afterNode(node.identity);
      ref('dialer', `node:${node.identity}`, node.dialer,
        mapping.get(node.dialer) !== undefined && after?.dialer === mapping.get(node.dialer));
    }
    for (const extra of profile.extraRefs ?? []) ref('dialer', extra.owner, extra.name, false);
  }
  if (references.some((r) => r.blocked)) warnings.push('存在非一对一或只读来源的精确节点引用；请先修复引用，不能自动应用。');
  return { ...template, sample: sample.slice(0, 20), groups,
    emptiedGroups: groups.filter((g) => g.emptied), references,
    warnings: [...new Set(warnings)], blocked: references.some((r) => r.blocked) || groups.some((g) => !!g.error) };
}

export function rankNamingCandidates(candidates: NamingCandidate[]): NamingCandidate[] {
  const score = (c: NamingCandidate) => [c.groups.filter((g) => g.before !== g.after || g.emptied).length,
    c.emptiedGroups.length, c.references.length];
  return [...candidates].sort((a, b) => score(a)[0] - score(b)[0] || score(a)[1] - score(b)[1] || score(a)[2] - score(b)[2]);
}
