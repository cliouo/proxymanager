'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import type { ProxyGroup, ProxyGroupTemplate } from '@/schemas';
import type { RefSummary } from '../_components/GroupEditor';
import {
  memberStat,
  usePreviewNodes,
  type MemberStat,
  type NodesBySub,
} from './useAvailableMembers';
import type { SubscriptionLite } from './model';

/**
 * Shared data layer for the 策略组 routes (list / detail / new).
 *
 * Fetches the four core resource lists the editor needs (groups / templates /
 * subscriptions / rules) plus the two extra lists the flow overview reads
 * (rule-sets / anchors), and the resolved node names (via usePreviewNodes —
 * the only authoritative source of real node names). Exposes the cross-group
 * reference + member-stat memos so every route page agrees on counts.
 *
 * Anchors / rule-sets are best-effort for the flow overview: if either 404s
 * (base not initialised, upstream down) the count degrades to 0 rather than
 * failing the whole page.
 */

interface RuleLite {
  id: string;
  policy: string;
}

export interface ProxyGroupsData {
  groups: ProxyGroup[];
  templates: ProxyGroupTemplate[];
  subs: SubscriptionLite[];
  rules: RuleLite[];
  ruleSets: { id: string }[];
  anchors: string[];
  nodeNames: string[];
  nodesBySub: NodesBySub;
  previewError: string | null;
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
  reloadPreview: () => Promise<void>;
  refSummaryFor: (g: ProxyGroup) => RefSummary;
  stat: (g: ProxyGroup) => MemberStat;
  refCount: (name: string) => number;
}

export function useProxyGroupsData(): ProxyGroupsData {
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [templates, setTemplates] = useState<ProxyGroupTemplate[]>([]);
  const [subs, setSubs] = useState<SubscriptionLite[]>([]);
  const [rules, setRules] = useState<RuleLite[]>([]);
  const [ruleSets, setRuleSets] = useState<{ id: string }[]>([]);
  const [anchors, setAnchors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const { nodeNames, nodesBySub, error: previewError, reload: reloadPreview } = usePreviewNodes();

  const reload = useCallback(async () => {
    try {
      const [gs, ts, ss, rs] = await Promise.all([
        api<{ data: ProxyGroup[] }>('/api/v1/proxy-groups'),
        api<{ data: ProxyGroupTemplate[] }>('/api/v1/proxy-group-templates'),
        api<{ data: SubscriptionLite[] }>('/api/v1/subscriptions'),
        api<{ data: RuleLite[] }>('/api/v1/rules'),
      ]);
      setGroups(gs.data);
      setTemplates(ts.data);
      setSubs(
        ss.data.map((s) => ({
          id: s.id,
          name: s.name,
          display_name: s.display_name,
          enabled: s.enabled,
          tags: s.tags ?? [],
        })),
      );
      setRules(rs.data.map((r) => ({ id: r.id, policy: r.policy })));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }

    // Flow-overview extras — best-effort, never block the page.
    try {
      const sets = await api<{ data: { id: string }[] }>('/api/v1/rule-sets');
      setRuleSets(sets.data.map((s) => ({ id: s.id })));
    } catch {
      setRuleSets([]);
    }
    try {
      const a = await api<{ data: string[] }>('/api/v1/anchors');
      setAnchors(a.data ?? []);
    } catch {
      setAnchors([]);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const ruleRefCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rules) m.set(r.policy, (m.get(r.policy) ?? 0) + 1);
    return m;
  }, [rules]);

  const refCount = useCallback((name: string) => ruleRefCount.get(name) ?? 0, [ruleRefCount]);

  const refSummaryFor = useCallback(
    (g: ProxyGroup): RefSummary => {
      const names = new Set(groups.map((x) => x.name));
      const refIn: string[] = [];
      const refOut: string[] = [];
      for (const other of groups) {
        if (other.id === g.id) continue;
        if (other.proxies?.includes(g.name) || other['dialer-proxy'] === g.name) {
          refIn.push(other.name);
        }
      }
      for (const p of g.proxies ?? []) if (names.has(p)) refOut.push(p);
      return { rules: refCount(g.name), refIn, refOut };
    },
    [groups, refCount],
  );

  const stat = useCallback(
    (g: ProxyGroup) => memberStat(g, nodeNames, subs, nodesBySub),
    [nodeNames, subs, nodesBySub],
  );

  return {
    groups,
    templates,
    subs,
    rules,
    ruleSets,
    anchors,
    nodeNames,
    nodesBySub,
    previewError,
    error,
    loaded,
    reload,
    reloadPreview,
    refSummaryFor,
    stat,
    refCount,
  };
}
