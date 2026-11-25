'use client';

import { useMemo } from 'react';
import { api, ApiError, request } from '@/ui/data/api';
import { keys, refreshProfile, refreshShared, usePools, usePreview, useSources } from '@/ui/data/hooks';
import { getQueryData, invalidate, setQueryData, useQuery } from '@/ui/data/query';
import type { Profile, ProxyGroup, ProxyGroupTemplate, SubscriptionAdminView } from '@/ui/data/types';
import { profileSourceIds, type CatalogLike } from './model';

/* ─── versioned group list ───────────────────────────────────────────── */

export interface GroupBook {
  groups: ProxyGroup[];
  version: number;
}

export const bookKey = (profileId: string) => keys.scoped(profileId, 'groups-book');

export async function fetchBook(profileId: string): Promise<GroupBook> {
  const res = await request<{ data: ProxyGroup[]; meta: { configVersion: number } }>('/proxy-groups', {
    query: { profileId },
  });
  return { groups: res.data.slice().sort((a, b) => a.rank - b.rank), version: res.meta.configVersion };
}

export function useGroupBook(profileId: string) {
  return useQuery<GroupBook>(bookKey(profileId), () => fetchBook(profileId));
}

/** Replace one group in the cached list right away (the refetch confirms it). */
export function putGroupLocally(profileId: string, group: ProxyGroup) {
  setQueryData<GroupBook>(bookKey(profileId), (book) =>
    book
      ? {
          ...book,
          groups: book.groups.some((g) => g.id === group.id)
            ? book.groups.map((g) => (g.id === group.id ? group : g))
            : [...book.groups, group].sort((a, b) => a.rank - b.rank),
        }
      : { groups: [group], version: 0 },
  );
}

export function afterGroupWrite(profileId: string) {
  refreshProfile(profileId);
}

/* ─── writes ─────────────────────────────────────────────────────────── */

export const groupApi = {
  create: (profileId: string, body: Record<string, unknown>) =>
    api.post<ProxyGroup>('/proxy-groups', body, { profileId }),
  patch: (profileId: string, id: string, body: Record<string, unknown>) =>
    api.patch<ProxyGroup>(`/proxy-groups/${id}`, body, { profileId }),
  remove: (profileId: string, id: string) => api.del(`/proxy-groups/${id}`, { profileId }),
};

/**
 * Persist a new order. Optimistic: the list shows it immediately; a stale
 * version (someone else wrote in between) is retried once against the fresh
 * list when the set of groups is unchanged, otherwise the order rolls back.
 */
export async function reorderGroups(profileId: string, ordered: ProxyGroup[]): Promise<void> {
  const key = bookKey(profileId);
  const before = getQueryData<GroupBook>(key);
  if (!before) return;
  const orderedIds = ordered.map((g) => g.id);
  setQueryData<GroupBook>(key, {
    version: before.version,
    groups: ordered.map((g, i) => ({ ...g, rank: (i + 1) * 10 })),
  });
  const send = (expectedVersion: number) =>
    api.post<ProxyGroup[]>('/proxy-groups/reorder', { orderedIds, expectedVersion }, { profileId });
  try {
    try {
      await send(before.version);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 412) throw error;
      const fresh = await fetchBook(profileId);
      const sameSet =
        fresh.groups.length === orderedIds.length && fresh.groups.every((g) => orderedIds.includes(g.id));
      if (!sameSet) throw error;
      await send(fresh.version);
    }
  } catch (error) {
    setQueryData<GroupBook>(key, before);
    throw error;
  } finally {
    afterGroupWrite(profileId);
  }
}

/* ─── templates (global) ─────────────────────────────────────────────── */

export const templateApi = {
  create: (body: Record<string, unknown>) => api.post<ProxyGroupTemplate>('/proxy-group-templates', body),
  patch: (id: string, body: Record<string, unknown>) =>
    api.patch<ProxyGroupTemplate>(`/proxy-group-templates/${id}`, body),
  remove: (id: string) => api.del(`/proxy-group-templates/${id}`),
};

/** Templates are shared by every profile: refresh the list and every profile's render. */
export function afterTemplateWrite() {
  invalidate(keys.templates);
  refreshShared();
}

/* ─── node catalog ───────────────────────────────────────────────────── */

export interface NodeCatalog extends CatalogLike {
  loading: boolean;
  /** The final config failed to render; node data is unavailable. */
  error: unknown;
  sources: SubscriptionAdminView[] | undefined;
  subsById: Map<string, SubscriptionAdminView>;
  /** Subscriptions feeding this profile (null while loading). */
  profileSubIds: Set<string> | null;
}

export function useNodeCatalog(profile: Profile): NodeCatalog {
  const preview = usePreview(profile);
  const sources = useSources();
  const pools = usePools();
  return useMemo(() => {
    const types = preview.data?.node_types ? new Map(Object.entries(preview.data.node_types)) : null;
    return {
      names: preview.data?.node_names ?? null,
      bySub: preview.data?.nodes_by_sub ?? null,
      types,
      loading: preview.isLoading,
      error: preview.data ? null : preview.error,
      sources: sources.data,
      subsById: new Map((sources.data ?? []).map((s) => [s.id, s])),
      profileSubIds: profileSourceIds(profile, sources.data, pools.data),
    };
  }, [preview.data, preview.error, preview.isLoading, sources.data, pools.data, profile]);
}

/** Readable reason for a failed render (first issue, else the message). */
export function renderErrorText(error: unknown): string {
  if (error instanceof ApiError) return error.issues[0]?.message ?? error.detail ?? error.title;
  if (error instanceof Error) return error.message;
  return String(error);
}
