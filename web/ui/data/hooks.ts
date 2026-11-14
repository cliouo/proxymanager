'use client';

import { api, request, type Query } from './api';
import { invalidate, useQuery, type QueryOptions } from './query';
import type {
  BaseData,
  ChainSummary,
  Collection,
  DashboardData,
  DevicePreview,
  HistoryPage,
  MetaData,
  ParsedConfig,
  PreviewData,
  Profile,
  ProxyGroup,
  ProxyGroupTemplate,
  PublicDevice,
  Rule,
  RulePageMeta,
  RuleSet,
  RuleSetListItem,
  RuleSummary,
  SetupApiStatus,
  SourceUsage,
  SubscriptionAdminView,
  AssistantConfig,
} from './types';

/* ─── keys ────────────────────────────────────────────────────────────── */

export const keys = {
  profiles: 'profiles',
  setup: 'setup',
  sources: 'sources',
  source: (id: string) => `source:${id}`,
  sourceUsage: (id: string) => `source-usage:${id}`,
  pools: 'pools',
  pool: (id: string) => `pool:${id}`,
  poolUsage: (id: string) => `pool-usage:${id}`,
  templates: 'templates',
  ruleSet: (id: string) => `rule-set:${id}`,
  history: 'history',
  assistantConfig: 'assistant-config',
  scoped: (pid: string, name: string) => `p:${pid}:${name}`,
};

const scope = (profileId: string) => ({ profileId });

/* ─── global resources ───────────────────────────────────────────────── */

export function useProfiles() {
  return useQuery<Profile[]>(keys.profiles, () => api.get<Profile[]>('/profiles'), {
    staleTime: 15_000,
  });
}

export function useSetupStatus(enabled = true) {
  return useQuery<SetupApiStatus>(enabled ? keys.setup : null, () =>
    api.get<SetupApiStatus>('/setup/status'),
  );
}

export function useSources() {
  return useDescribed(queries.sources());
}

export function useSource(id: string | null) {
  return useDescribed(id ? queries.source(id) : null);
}

export function useSourceUsage(kind: 'subscription' | 'collection', id: string | null) {
  return useDescribed(id ? queries.usage(kind, id) : null);
}

export function usePools() {
  return useDescribed(queries.pools());
}

export function usePool(id: string | null) {
  return useDescribed(id ? queries.pool(id) : null);
}

export function useGroupTemplates() {
  return useDescribed(queries.templates());
}

export function useRuleSet(id: string | null) {
  return useQuery<RuleSet>(id ? keys.ruleSet(id) : null, () => api.get<RuleSet>(`/rule-sets/${id}`));
}

export function useHistory(limit = 60) {
  return useQuery<HistoryPage>(`${keys.history}:${limit}`, () =>
    request<HistoryPage>('/history', { query: { limit } }),
  );
}

export function useAssistantConfig(enabled = true) {
  return useQuery<AssistantConfig | null>(enabled ? keys.assistantConfig : null, async () => {
    try {
      return await api.get<AssistantConfig>('/assistant/config');
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  });
}

/* ─── profile-scoped resources ───────────────────────────────────────── */

/**
 * Key + fetcher (+ freshness) per resource, shared by the hooks below and by
 * intent prefetch (ui/shell/prefetch.ts), so a hovered link warms exactly the
 * cache entries its page will read.
 */
export interface QueryDescriptor<T> {
  key: string;
  fetcher: () => Promise<T>;
  staleTime?: number;
}

export const queries = {
  sources: (): QueryDescriptor<SubscriptionAdminView[]> => ({
    key: keys.sources,
    fetcher: () => api.get<SubscriptionAdminView[]>('/subscriptions'),
  }),
  pools: (): QueryDescriptor<Collection[]> => ({
    key: keys.pools,
    fetcher: () => api.get<Collection[]>('/collections'),
  }),
  source: (id: string): QueryDescriptor<SubscriptionAdminView> => ({
    key: keys.source(id),
    fetcher: () => api.get<SubscriptionAdminView>(`/subscriptions/${id}`),
  }),
  pool: (id: string): QueryDescriptor<Collection> => ({
    key: keys.pool(id),
    fetcher: () => api.get<Collection>(`/collections/${id}`),
  }),
  usage: (kind: 'subscription' | 'collection', id: string): QueryDescriptor<SourceUsage> => ({
    key: kind === 'subscription' ? keys.sourceUsage(id) : keys.poolUsage(id),
    fetcher: () => api.get<SourceUsage>(`/${kind === 'subscription' ? 'subscriptions' : 'collections'}/${id}/usage`),
  }),
  templates: (): QueryDescriptor<ProxyGroupTemplate[]> => ({
    key: keys.templates,
    fetcher: () => api.get<ProxyGroupTemplate[]>('/proxy-group-templates'),
  }),
  dashboard: (pid: string): QueryDescriptor<DashboardData> => ({
    key: keys.scoped(pid, 'dashboard'),
    fetcher: () => api.get<DashboardData>('/dashboard', scope(pid)),
  }),
  meta: (pid: string): QueryDescriptor<MetaData> => ({
    key: keys.scoped(pid, 'meta'),
    fetcher: () => api.get<MetaData>('/meta', scope(pid)),
  }),
  groups: (pid: string): QueryDescriptor<ProxyGroup[]> => ({
    key: keys.scoped(pid, 'groups'),
    fetcher: () => api.get<ProxyGroup[]>('/proxy-groups', scope(pid)),
  }),
  policies: (pid: string): QueryDescriptor<string[]> => ({
    key: keys.scoped(pid, 'policies'),
    fetcher: () => api.get<string[]>('/policies', scope(pid)),
  }),
  anchors: (pid: string): QueryDescriptor<string[]> => ({
    key: keys.scoped(pid, 'anchors'),
    fetcher: () => api.get<string[]>('/anchors', scope(pid)),
  }),
  ruleSummary: (pid: string): QueryDescriptor<RuleSummary> => ({
    key: keys.scoped(pid, 'rule-summary'),
    fetcher: () => api.get<RuleSummary>('/rules/summary', scope(pid)),
  }),
  allRules: (pid: string): QueryDescriptor<Rule[]> => ({
    key: keys.scoped(pid, 'rules-all'),
    fetcher: () => fetchAllRules(pid),
  }),
  ruleSets: (pid: string): QueryDescriptor<RuleSetListItem[]> => ({
    key: keys.scoped(pid, 'rule-sets'),
    fetcher: () => api.get<RuleSetListItem[]>('/rule-sets', scope(pid)),
  }),
  base: (pid: string): QueryDescriptor<BaseData> => ({
    key: keys.scoped(pid, 'base'),
    fetcher: () => api.get<BaseData>('/base', scope(pid)),
    staleTime: 60_000,
  }),
  preview: (profile: Profile): QueryDescriptor<PreviewData> => ({
    key: keys.scoped(profile.id, 'preview'),
    fetcher: () => api.get<PreviewData>(`/preview/${encodeURIComponent(profile.name)}`, scope(profile.id)),
    staleTime: 15_000,
  }),
  parsed: (pid: string): QueryDescriptor<ParsedConfig> => ({
    key: keys.scoped(pid, 'parsed'),
    fetcher: () => api.get<ParsedConfig>('/base/parsed', scope(pid)),
    staleTime: 15_000,
  }),
  devices: (pid: string): QueryDescriptor<PublicDevice[]> => ({
    key: keys.scoped(pid, 'devices'),
    fetcher: () => api.get<PublicDevice[]>(`/profiles/${pid}/devices`),
  }),
  chains: (pid: string): QueryDescriptor<ChainSummary> => ({
    key: keys.scoped(pid, 'chains'),
    fetcher: () => api.get<ChainSummary>('/scenarios/chained-proxy', scope(pid)),
  }),
};

/** useQuery over a descriptor; `null` disables it. */
function useDescribed<T>(descriptor: QueryDescriptor<T> | null, options?: QueryOptions) {
  return useQuery<T>(descriptor?.key ?? null, descriptor?.fetcher ?? noFetch, {
    ...(descriptor?.staleTime !== undefined ? { staleTime: descriptor.staleTime } : {}),
    ...options,
  });
}

const noFetch = () => Promise.reject(new Error('disabled query'));

export function useDashboard(profileId: string | null, options?: QueryOptions) {
  return useDescribed(profileId ? queries.dashboard(profileId) : null, options);
}

export function useMeta(profileId: string | null) {
  return useDescribed(profileId ? queries.meta(profileId) : null);
}

export function useGroups(profileId: string | null) {
  return useDescribed(profileId ? queries.groups(profileId) : null);
}

export function usePolicies(profileId: string | null) {
  return useDescribed(profileId ? queries.policies(profileId) : null);
}

export function useAnchors(profileId: string | null) {
  return useDescribed(profileId ? queries.anchors(profileId) : null);
}

export function useRuleSummary(profileId: string | null) {
  return useDescribed(profileId ? queries.ruleSummary(profileId) : null);
}

export interface RuleQuery {
  anchor?: string;
  policy?: string;
  type?: string;
  enabled?: 'true' | 'false';
  q?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export function useRules(profileId: string | null, query: RuleQuery) {
  const q: Query = { ...query, ...(profileId ? scope(profileId) : {}) };
  const qs = new URLSearchParams(
    Object.entries(query).flatMap(([k, v]) => (v === undefined || v === '' ? [] : [[k, String(v)]])),
  ).toString();
  return useQuery<{ data: Rule[]; meta: RulePageMeta }>(
    profileId ? keys.scoped(profileId, `rules?${qs}`) : null,
    () => request<{ data: Rule[]; meta: RulePageMeta }>('/rules', { query: q }),
    { keepPrevious: true },
  );
}

/** Every rule of a profile (pages through the 500-row API limit). */
export async function fetchAllRules(profileId: string): Promise<Rule[]> {
  const all: Rule[] = [];
  for (let offset = 0; offset < 20_000; offset += 500) {
    const page = await request<{ data: Rule[]; meta: RulePageMeta }>('/rules', {
      query: { profileId, limit: 500, offset },
    });
    all.push(...page.data);
    if (all.length >= page.meta.total || page.data.length === 0) break;
  }
  return all;
}

export function useAllRules(profileId: string | null) {
  return useDescribed(profileId ? queries.allRules(profileId) : null);
}

export function useRuleSets(profileId: string | null) {
  return useDescribed(profileId ? queries.ruleSets(profileId) : null);
}

export function useBase(profileId: string | null) {
  return useDescribed(profileId ? queries.base(profileId) : null);
}

export function usePreview(profile: Profile | null, options?: QueryOptions) {
  return useDescribed(profile ? queries.preview(profile) : null, options);
}

export function useParsed(profileId: string | null) {
  return useDescribed(profileId ? queries.parsed(profileId) : null);
}

export function useDevices(profileId: string | null) {
  return useDescribed(profileId ? queries.devices(profileId) : null);
}

export function useDevice(profileId: string | null, deviceId: string | null) {
  return useQuery<PublicDevice>(
    profileId && deviceId ? keys.scoped(profileId, `device:${deviceId}`) : null,
    () => api.get<PublicDevice>(`/profiles/${profileId}/devices/${deviceId}`),
  );
}

export function useDevicePreview(profileId: string | null, deviceId: string | null) {
  return useQuery<DevicePreview>(
    profileId && deviceId ? keys.scoped(profileId, `device-preview:${deviceId}`) : null,
    () => api.get<DevicePreview>(`/profiles/${profileId}/devices/${deviceId}/preview`),
  );
}

export function useChains(profileId: string | null) {
  return useDescribed(profileId ? queries.chains(profileId) : null);
}

/* ─── invalidation helpers ───────────────────────────────────────────── */

/** Anything profile-scoped changed: refresh that profile's views + history. */
export function refreshProfile(profileId: string) {
  invalidate(`p:${profileId}:`, keys.history);
}

/** A shared resource changed (source / pool / rule-set): every profile's render may differ. */
export function refreshShared() {
  invalidate(
    keys.sources,
    'source:',
    'source-usage:',
    keys.pools,
    'pool:',
    'pool-usage:',
    'rule-set:',
    keys.profiles,
    keys.history,
    (key) => key.startsWith('p:'),
  );
}

export function refreshProfiles() {
  invalidate(keys.profiles, keys.setup, keys.history);
}
