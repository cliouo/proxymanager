import { parse } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { nodeFingerprint, recognizeName } from '@/lib/proxies/naming';
import { generateNamingGroups, groupingCounts, templateForGrouping, type GroupingPurpose, type GroupingPreview } from '@/lib/proxies/namingGroupGeneration';
import { envelopeOf, fingerprintOf, sourceOf } from '@/lib/proxies/provenance';
import { safeIssueText as safeSampleName } from './pipelinePreview';
import { redactSensitiveText } from '@/lib/proxies/namingSanitize';
import {
  analyzeNamingCandidate, inferNamingTemplates, rankNamingCandidates,
  type CandidateNode, type CandidateProfile, type NamingCandidate,
} from '@/lib/proxies/namingCandidates';
import { getBase } from '@/lib/repos/baseRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { buildOperatorSnapshot } from '@/lib/repos/rawOperators';
import { mergeWithTemplate, ProxyGroupSchema } from '@/schemas/proxyGroup';
import type { Collection, Profile, ProxyGroup, Rule, Subscription } from '@/schemas';
import type { NamingProfileChange } from '@/schemas/namingProfileChanges';
import { consumingProfilesOfCollection, consumingProfilesOfSubscription } from './nodePipelineSaveGate';
import { createOrdinalPlanningSession } from './nodeOrdinalService';
import { resolveSubscriptionForPreflight, type SubscriptionPreflightSnapshot } from './configPreflight';
import { exportCollectionNodes, exportSubscriptionNodes } from './nodeExportService';
import { buildManagedCandidate, completeNamingPlan, priorPolicyOf } from './namingManagedCandidate';

interface ProfileInput {
  profile: Profile;
  groups: ProxyGroup[];
  hasBaseGroups: boolean;
  rules: Rule[];
  baseNodes: Record<string, unknown>[];
  baseRefs: { owner: string; name: string }[];
}

export async function loadNamingCandidateContext(type: 'subscription' | 'collection', id: string, version: number) {
  const [subscriptions, collections, profiles, templates] = await Promise.all([
    listSubscriptions(), listCollections(), listProfiles(), listProxyGroupTemplates(),
  ]);
  const entity = type === 'subscription' ? subscriptions.find((s) => s.id === id) : collections.find((c) => c.id === id);
  if (!entity) throw ProblemDetailsError.notFound('命名目标不存在。');
  const affected = type === 'subscription'
    ? consumingProfilesOfSubscription(entity as Subscription, collections, subscriptions, profiles)
    : consumingProfilesOfCollection(id, profiles);
  const inputs: ProfileInput[] = await Promise.all(affected.map(async (profile) => {
    const [groups, rules, base] = await Promise.all([listProxyGroups(profile.id), listRules(profile.id), getBase(profile.id)]);
    const document = base ? parse(base.content) as Record<string, unknown> : {};
    const baseNodes = Array.isArray(document?.proxies) ? document.proxies.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object' && !Array.isArray(n)) : [];
    const baseRefs: ProfileInput['baseRefs'] = [];
    if (Array.isArray(document?.rules)) for (const rule of document.rules) {
      if (typeof rule === 'string') {
        const tokens = rule.split(',');
        const name = tokens.at(-1) === 'no-resolve' ? tokens.at(-2) : tokens.at(-1);
        if (name) baseRefs.push({ owner: 'base:rule', name });
      }
    }
    return { profile, groups, rules, baseNodes, baseRefs, hasBaseGroups: Array.isArray(document?.['proxy-groups']) && document['proxy-groups'].length > 0 };
  }));
  if (await getConfigVersion() !== version) throw ProblemDetailsError.preconditionFailed('配置已修改，请刷新推荐方案。');
  const subscriptionSnapshot: SubscriptionPreflightSnapshot = new Map();
  const ordinalPlanningSession = await createOrdinalPlanningSession(subscriptions.map((s) => s.name));
  const resolver: typeof import('./subscriptionFetcher').resolveSubscriptionProxies = (sub, options) =>
    resolveSubscriptionForPreflight(sub, { subscriptionSnapshot, ordinalPlanningSession, managedCollection: options?.managedCollection });
  const exportOptions = { writeCache: false, preserveEnvelope: true, ordinalPlanningSession, resolveSubscription: resolver };
  const scope = (node: Record<string, unknown>) => type === 'collection' || sourceOf(node)?.key === (entity as Subscription).name;
  const nodeOf = (node: Record<string, unknown>, scoped: boolean, namingEntity = entity): CandidateNode => {
    const managed = buildOperatorSnapshot(namingEntity).managed?.decoded;
    const rendered = envelopeOf(node)?.renderedNaming;
    return {
      identity: fingerprintOf(node) ?? nodeFingerprint(node) ?? `name:${String(node.name)}`,
      name: String(node.name ?? ''), type: String(node.type ?? ''), scoped,
      facts: (rendered && !rendered.stale ? rendered.facts : undefined) ?? (() => {
        const facts = recognizeName(String(node.name ?? ''), undefined, { detectInfo: false });
        return { region: facts.region ?? undefined, tags: facts.tags, rate: facts.rate ?? undefined, vendor: facts.vendor ?? undefined };
      })(),
      sourceKey: sourceOf(node)?.key,
      sourceId: subscriptions.find((s) => s.name === sourceOf(node)?.key)?.id,
      namingTemplate: rendered?.template ?? null,
      namingTw2cn: rendered?.tw2cn,
      sourceLabel: rendered?.sourceLabel ?? (managed?.kind === 'rename-template' ? managed.sourceAliases?.[sourceOf(node)?.key ?? ''] : undefined)
        ?? envelopeOf(node)?.memberNaming?.sourceAlias ?? sourceOf(node)?.label,
      ...(typeof node['dialer-proxy'] === 'string' ? { dialer: node['dialer-proxy'] } : {}),
    };
  };
  const pool = async (input: ProfileInput, next?: Subscription | Collection) => {
    const { profile } = input;
    const profileOptions = { ...exportOptions, baseProxyNames: new Set(input.baseNodes.map((node) => String(node.name))) };
    const subs = type === 'subscription' && next ? subscriptions.map((s) => s.id === id ? next as Subscription : s) : subscriptions;
    const cols = type === 'collection' && next ? collections.map((c) => c.id === id ? next as Collection : c) : collections;
    const source = profile.source;
    if (source.type === 'subscription') {
      const sub = subs.find((s) => s.id === source.id);
      if (!sub) throw ProblemDetailsError.preconditionFailed('配置文件的订阅源不存在。');
      return (await exportSubscriptionNodes(sub, profileOptions)).proxies.map((n) => nodeOf(n, scope(n), sub));
    }
    if (source.type === 'collection') {
      const col = cols.find((c) => c.id === source.id);
      if (!col) throw ProblemDetailsError.preconditionFailed('配置文件的聚合订阅不存在。');
      return (await exportCollectionNodes(col, subs, profileOptions)).proxies.map((n) => nodeOf(n, scope(n), col));
    }
    return [];
  };
  const before = await Promise.all(inputs.map((input) => pool(input)));
  const targetSample = async (next: Subscription | Collection) => type === 'subscription'
    ? (await exportSubscriptionNodes(next as Subscription, exportOptions)).proxies
    : (await exportCollectionNodes(next as Collection, subscriptions, exportOptions)).proxies;
  const candidateEntity = (template: string) => {
    const managed = buildOperatorSnapshot(entity).managed?.decoded;
    return { ...entity, operators: buildManagedCandidate(buildOperatorSnapshot(entity),
      completeNamingPlan({ template }, priorPolicyOf(managed))).storage } as Subscription | Collection;
  };
  const analyze = async (next: Subscription | Collection, description: { id: string; title: string; template: string }) => {
    const profilePools: CandidateProfile[] = await Promise.all(inputs.map(async (input, index) => {
      const after = await pool(input, next);
      const actualAfter = new Map(after.map((node) => [node.identity, node]));
      const affectedIdentities = new Set(before[index]
        .filter((node) => actualAfter.get(node.identity)?.name !== node.name)
        .map((node) => node.identity));
      const affected = (node: CandidateNode) => ({ ...node, scoped: node.scoped || affectedIdentities.has(node.identity) });
      const groups = input.groups.map((group) => {
        let boundSourceKeys: string[] | undefined;
        if (group.kind === 'single-sub' && group.bound_subscription_id) {
          boundSourceKeys = subscriptions.filter((s) => s.id === group.bound_subscription_id).map((s) => s.name);
        } else if (group.bound_collection_id) {
          const collection = collections.find((c) => c.id === group.bound_collection_id);
          boundSourceKeys = collection ? enabledCollectionMemberSubs(collection, subscriptions).map((s) => s.name) : [];
        }
        return { id: group.id, name: group.name,
          values: mergeWithTemplate(group, templates.find((t) => t.id === group.template_id)), boundSourceKeys };
      });
      const baseNodes = input.baseNodes.map((node) => nodeOf(node, false));
      return { id: input.profile.id, name: input.profile.name, groups, rules: input.rules,
        before: [...baseNodes, ...before[index].map(affected)],
        after: [...baseNodes, ...after.map(affected)],
        extraRefs: input.baseRefs };
    }));
    const sample = await targetSample(next);
    const result = analyzeNamingCandidate(description, profilePools, sample.map((n) => String(n.name)));
    if (await getConfigVersion() !== version) throw ProblemDetailsError.preconditionFailed('配置已修改，请刷新推荐方案。');
    return result;
  };
  const changesFor = (candidate: NamingCandidate): NamingProfileChange[] => {
    if (candidate.blocked) throw ProblemDetailsError.unprocessable('存在无法自动迁移的精确引用或无效筛选，请先修复引用。');
    return inputs.map((input) => {
      const groups = input.groups.flatMap((before) => {
        const refs = candidate.references.filter((r) => r.profileId === input.profile.id && r.owner === before.id && r.after);
        const migration = candidate.groups.find((g) => g.profileId === input.profile.id && g.groupId === before.id)?.migration;
        if (!refs.length && !migration) return [];
        let after = { ...before };
        for (const ref of refs) {
          if (ref.kind === 'manual') after = { ...after, proxies: (after.proxies ?? []).map((n) => n === ref.before ? ref.after! : n) };
          if (ref.kind === 'dialer') after = { ...after, 'dialer-proxy': ref.after };
          if (ref.kind === 'fallback') after = { ...after, 'empty-fallback': ref.after };
        }
        if (migration) after = { ...after, filter: migration.filter };
        return [{ before, after: { ...after, updated_at: Math.floor(Date.now() / 1000) } }];
      });
      const rules = input.rules.flatMap((before) => {
        const ref = candidate.references.find((r) => r.profileId === input.profile.id && r.kind === 'rule' && r.owner === before.id && r.after);
        return ref ? [{ before, after: { ...before, policy: ref.after!, revision: version + 1, updated_at: Math.floor(Date.now() / 1000) } }] : [];
      });
      return { profileId: input.profile.id, groups, rules };
    }).filter((p) => p.groups.length || p.rules.length);
  };
  const recommend = async () => {
    const sample = await targetSample(entity);
    const nodes = sample.map((n) => nodeOf(n, true));
    const groups = inputs.flatMap((input) => input.groups.map((group) => ({ id: group.id, name: group.name, values: mergeWithTemplate(group, templates.find((t) => t.id === group.template_id)) })));
    const candidates: NamingCandidate[] = [];
    for (const item of inferNamingTemplates(nodes, groups, type === 'collection')) {
      try {
        candidates.push(await analyze(candidateEntity(item.template), item));
      } catch (error) {
        if (await getConfigVersion() !== version) throw error;
        candidates.push({ ...item, groups: [], emptiedGroups: [], sample: [], references: [], blocked: true,
          warnings: ['此方案无法通过节点处理流水线，请保留现有方案或调整后续处理步骤。'] });
      }
    }
    return rankNamingCandidates(candidates);
  };
  const eligible = inputs.filter((input) => !input.groups.length && !input.hasBaseGroups);
  const generatedFor = async (next: Subscription | Collection, template: string, purposes: GroupingPurpose[]) => Promise.all(eligible.map(async (input) => {
    const nodes = [...input.baseNodes.map((node) => nodeOf(node, false)), ...await pool(input, next)];
    return { input, nodes, ...generateNamingGroups(nodes, template, purposes) };
  }));
  const grouping = async (purposes?: GroupingPurpose[]): Promise<GroupingPreview> => {
    const recommended = (await recommend()).find((candidate) => candidate.id === 'recommended');
    if (!recommended) throw ProblemDetailsError.unprocessable('无法生成推荐命名模板。');
    const initial = candidateEntity(recommended.template);
    const pools = await Promise.all(eligible.map(async (input) => [...input.baseNodes.map((node) => nodeOf(node, false)), ...await pool(input, initial)]));
    const counts = groupingCounts(pools.flat());
    const selected = purposes ?? counts.filter((p) => p.id === 'region' || p.count >= 2).map((p) => p.id);
    const template = templateForGrouping(recommended.template, selected);
    const generated = await generatedFor(candidateEntity(template), template, selected);
    if (await getConfigVersion() !== version) throw ProblemDetailsError.preconditionFailed('配置已修改，请刷新推荐方案。');
    return { configVersion: version, template, purposes: groupingCounts(generated.flatMap((g) => g.nodes)).map((p) => ({ ...p, selected: selected.includes(p.id) })),
      profiles: generated.map((g) => ({ name: g.input.profile.name, groups: g.groups })),
      warnings: generated.flatMap((g) => g.warnings), blocked: !generated.length || generated.some((g) => g.blocked) };
  };
  const groupChanges = async (next: Subscription | Collection, template: string, purposes: GroupingPurpose[]): Promise<NamingProfileChange[]> => {
    const generated = await generatedFor(next, template, purposes);
    if (!generated.length || generated.some((g) => g.blocked)) throw ProblemDetailsError.unprocessable('无法安全生成策略组，请刷新分组预览。');
    return generated.map((g) => ({ profileId: g.input.profile.id, groups: [], rules: [], createdGroups: g.groups.map((group, rank) =>
      ProxyGroupSchema.parse({ id: crypto.randomUUID(), name: group.name, kind: group.kind, type: group.type, rank, updated_at: Math.floor(Date.now() / 1000),
        filter: group.filter, 'include-all-proxies': group['include-all-proxies'], proxies: group.proxies, bound_subscription_id: group.bound_subscription_id })) }));
  };
  return { analyze, changesFor, recommend, grouping, groupChanges, hasGrouplessProfiles: eligible.length > 0, subscriptionSnapshot, ordinalPlanningSession };
}

export function publicGroupingPreview(preview: GroupingPreview): GroupingPreview {
  return { ...preview, profiles: preview.profiles.map((p) => ({ name: safeSampleName(p.name), groups: p.groups.map((g) => ({
    name: safeSampleName(g.name), kind: g.kind, type: g.type, count: g.count,
    sample: g.sample,
    ...(g.filter ? { filter: redactSensitiveText(g.filter).slice(0, 4096), 'include-all-proxies': true } : {}),
    ...(g.proxies ? { proxies: g.proxies.map(safeSampleName) } : {}),
  })) })), warnings: preview.warnings.map((w) => redactSensitiveText(w).slice(0, 256)) };
}

export function publicNamingCandidate(candidate: NamingCandidate): NamingCandidate {
  const groupPublic = (g: NamingCandidate['groups'][number]) => ({ ...g,
    groupName: safeSampleName(g.groupName), profileName: safeSampleName(g.profileName),
    ...(g.error ? { error: safeSampleName(g.error) } : {}),
    ...(g.migration ? { migration: { ...g.migration, filter: redactSensitiveText(g.migration.filter).slice(0, 512) } } : {}),
  });
  return { ...candidate,
    references: candidate.references.map((r) => ({ ...r,
      owner: r.owner.startsWith('node:') || r.owner.startsWith('base:') ? 'node' : r.owner })),
    warnings: candidate.warnings.map((w) => redactSensitiveText(w).slice(0, 256)),
    groups: candidate.groups.map(groupPublic), emptiedGroups: candidate.emptiedGroups.map(groupPublic) };
}
