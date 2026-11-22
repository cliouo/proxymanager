import { parse } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { nodeFingerprint } from '@/lib/proxies/naming';
import { fingerprintOf, sourceOf } from '@/lib/proxies/provenance';
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
import { mergeWithTemplate } from '@/schemas/proxyGroup';
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
    return { profile, groups, rules, baseNodes, baseRefs };
  }));
  if (await getConfigVersion() !== version) throw ProblemDetailsError.preconditionFailed('配置已修改，请刷新推荐方案。');
  const subscriptionSnapshot: SubscriptionPreflightSnapshot = new Map();
  const ordinalPlanningSession = await createOrdinalPlanningSession(subscriptions.map((s) => s.name));
  const resolver: typeof import('./subscriptionFetcher').resolveSubscriptionProxies = (sub, options) =>
    resolveSubscriptionForPreflight(sub, { subscriptionSnapshot, ordinalPlanningSession, managedCollection: options?.managedCollection });
  const exportOptions = { writeCache: false, preserveEnvelope: true, ordinalPlanningSession, resolveSubscription: resolver };
  const scope = (node: Record<string, unknown>) => type === 'collection' || sourceOf(node)?.key === (entity as Subscription).name;
  const nodeOf = (node: Record<string, unknown>, scoped: boolean): CandidateNode => ({
    identity: fingerprintOf(node) ?? nodeFingerprint(node) ?? `name:${String(node.name)}`,
    name: String(node.name ?? ''), type: String(node.type ?? ''), scoped,
    sourceKey: sourceOf(node)?.key,
    ...(typeof node['dialer-proxy'] === 'string' ? { dialer: node['dialer-proxy'] } : {}),
  });
  const pool = async (input: ProfileInput, next?: Subscription | Collection) => {
    const { profile } = input;
    const profileOptions = { ...exportOptions, baseProxyNames: new Set(input.baseNodes.map((node) => String(node.name))) };
    const subs = type === 'subscription' && next ? subscriptions.map((s) => s.id === id ? next as Subscription : s) : subscriptions;
    const cols = type === 'collection' && next ? collections.map((c) => c.id === id ? next as Collection : c) : collections;
    const source = profile.source;
    if (source.type === 'subscription') {
      const sub = subs.find((s) => s.id === source.id);
      if (!sub) throw ProblemDetailsError.preconditionFailed('配置文件的订阅源不存在。');
      return (await exportSubscriptionNodes(sub, profileOptions)).proxies.map((n) => nodeOf(n, scope(n)));
    }
    if (source.type === 'collection') {
      const col = cols.find((c) => c.id === source.id);
      if (!col) throw ProblemDetailsError.preconditionFailed('配置文件的聚合订阅不存在。');
      return (await exportCollectionNodes(col, subs, profileOptions)).proxies.map((n) => nodeOf(n, scope(n)));
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
        before: [...baseNodes, ...before[index]],
        after: [...baseNodes, ...before[index].filter((n) => !n.scoped).map((node) => ({
          ...node, dialer: actualAfter.get(node.identity)?.dialer,
        })), ...after.filter((n) => n.scoped)],
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
  return { analyze, changesFor, recommend, subscriptionSnapshot, ordinalPlanningSession };
}

export function publicNamingCandidate(candidate: NamingCandidate): NamingCandidate {
  const groupPublic = (g: NamingCandidate['groups'][number]) => ({ ...g,
    groupName: safeSampleName(g.groupName), profileName: safeSampleName(g.profileName),
    ...(g.error ? { error: safeSampleName(g.error) } : {}),
    ...(g.migration ? { migration: { ...g.migration, filter: redactSensitiveText(g.migration.filter).slice(0, 512) } } : {}),
  });
  return { ...candidate, sample: candidate.sample.map(safeSampleName),
    references: candidate.references.map((r) => ({ ...r,
      owner: r.owner.startsWith('node:') || r.owner.startsWith('base:') ? 'node' : r.owner,
      before: safeSampleName(r.before), after: r.after === undefined ? undefined : safeSampleName(r.after) })),
    warnings: candidate.warnings.map((w) => redactSensitiveText(w).slice(0, 256)),
    groups: candidate.groups.map(groupPublic), emptiedGroups: candidate.emptiedGroups.map(groupPublic) };
}
