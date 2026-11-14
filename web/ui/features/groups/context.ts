'use client';

import { createContext, useContext } from 'react';
import type { QueryResult } from '@/ui/data/query';
import type { Profile, ProxyGroup, ProxyGroupTemplate } from '@/ui/data/types';
import type { GroupBook, NodeCatalog } from './data';
import type { SummaryContext } from './model';

export interface WorkspaceValue {
  profile: Profile;
  profileId: string;
  path: (sub?: string) => string;
  book: QueryResult<GroupBook>;
  /** Sorted by rank; empty while loading. */
  groups: ProxyGroup[];
  ruleCounts: Record<string, number>;
  rulesLoaded: boolean;
  catalog: NodeCatalog;
  summaryCtx: SummaryContext;
  templates: ProxyGroupTemplate[] | undefined;
  frontPools: Set<string>;
  /** single-sub groups that will not get any node, with the reason. */
  brokenBindings: Map<string, string>;
  selectedId: string | null;
  hrefFor: (id: string | null) => string;
  /** Navigate to a group (or the overview), asking first when edits are unsaved. */
  select: (id: string | null, options?: { force?: boolean }) => Promise<void>;
  openCreate: () => void;
  openTemplates: () => void;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside the groups workspace');
  return value;
}
