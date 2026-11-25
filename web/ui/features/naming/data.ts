'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/ui/data/api';
import { useQuery } from '@/ui/data/query';
import type { NamesPayload } from '@/ui/data/types';
import { NodeFactsSchema } from '@/schemas/nodeFacts';
import type { NamingPlan, NamingPreviewData, NamingWorkspaceData, TargetType } from './model';

const path = (type: TargetType, id: string) => `/naming/${type}/${id}`;
const entityPath = (type: TargetType, id: string) =>
  type === 'subscription' ? `/subscriptions/${id}` : `/collections/${id}`;
export const namingKey = (type: TargetType, id: string) => `naming:${type}:${id}`;

/** Reads are bracketed by the global config version: a write elsewhere mid-read yields 412 — just retry. */
async function retryOnRace<T>(run: () => Promise<T>, tries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt < tries && error instanceof ApiError && error.status === 412) continue;
      throw error;
    }
  }
}

export function useNamingWorkspace(type: TargetType, id: string | null) {
  return useQuery<NamingWorkspaceData>(id ? namingKey(type, id) : null, () =>
    retryOnRace(() => api.get<NamingWorkspaceData>(path(type, id!))),
  );
}

export interface CurrentNames {
  names: NamesPayload;
  operators: Array<{ kind: string; disabled?: boolean }>;
}

/** The names configs carry today: the target's own pipeline, dry-run, in output order. */
export function useCurrentNames(type: TargetType, id: string | null, version: number | undefined) {
  return useQuery<CurrentNames>(
    id && version !== undefined ? `${namingKey(type, id)}:now:${version}` : null,
    async () => {
      const entity = await api.get<{ operators?: CurrentNames['operators'] }>(entityPath(type, id!));
      const operators = entity.operators ?? [];
      const preview = await api.post<{ after: NamesPayload }>(`${entityPath(type, id!)}/preview`, { operators });
      return { names: preview.after, operators };
    },
    { staleTime: 60_000 },
  );
}

/** Dry-run of a draft plan (no write). `planJson` is the serialized plan body. */
export function useNamingPreview(
  type: TargetType,
  id: string | null,
  version: number | undefined,
  planJson: string | null,
) {
  return useQuery<NamingPreviewData>(
    id && version !== undefined && planJson ? `${namingKey(type, id)}:preview:${version}:${planJson}` : null,
    () =>
      retryOnRace(() =>
        api.post<NamingPreviewData>(path(type, id!), { preview: JSON.parse(planJson!) as NamingPlan }),
      ),
    { keepPrevious: true, staleTime: 60_000 },
  );
}

export function applyPlan(type: TargetType, id: string, plan: NamingPlan, expectedVersion: number) {
  return api.post<NamingWorkspaceData>(path(type, id), { apply: plan, expectedVersion });
}

export function rollbackPlan(type: TargetType, id: string, expectedVersion: number) {
  return api.post<NamingWorkspaceData>(path(type, id), { rollback: true, expectedVersion });
}

/** 关闭智能命名: the managed step is kept (disabled) so names revert to the
 * originals; 「撤销上次应用」 re-enables it. */
export function disablePlan(type: TargetType, id: string, expectedVersion: number) {
  return api.post<NamingWorkspaceData>(path(type, id), { disable: true, expectedVersion });
}

export async function recognizeNodeFacts(ref: string) {
  const result = await api.post<{
    nodeFacts: unknown;
    proposed: number;
    considered: number;
    truncated: boolean;
  }>('/assistant/naming-analysis', { ref, mode: 'node-facts' });
  return { ...result, nodeFacts: NodeFactsSchema.parse(result.nodeFacts) };
}

export const isVersionConflict = (error: unknown) =>
  error instanceof ApiError && (error.status === 412 || error.status === 409);

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
