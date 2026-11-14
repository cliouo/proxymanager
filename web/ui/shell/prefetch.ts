'use client';

import { keys, queries, type QueryDescriptor } from '@/ui/data/hooks';
import { getQueryData, prefetchQuery } from '@/ui/data/query';
import type { Profile } from '@/ui/data/types';
import { fetchBook, bookKey as groupBookKey } from '@/ui/features/groups/data';
import { fetchLedgerHead, LEDGER_KEY } from '@/ui/features/history/ledger';
import { fetchRuleBook, ruleBookKey } from '@/ui/features/rules/use-rule-book';

/**
 * Intent prefetch: when a link is hovered, focused or pressed, start the
 * requests its page will make. On a backend where every call costs a few
 * hundred ms, the ~150–300 ms between hover and click is often enough for the
 * page to open with fresh data instead of a skeleton.
 */

type Plan = Array<QueryDescriptor<unknown>>;

function profileSection(section: string, profile: Profile): Plan {
  const id = profile.id;
  switch (section) {
    case '':
      return [queries.dashboard(id), queries.preview(profile), queries.groups(id), queries.devices(id), queries.allRules(id)];
    case 'groups':
      return [
        { key: groupBookKey(id), fetcher: () => fetchBook(id) },
        queries.templates(),
        queries.ruleSummary(id),
        queries.preview(profile),
        queries.parsed(id),
      ];
    case 'rules':
      return [
        { key: ruleBookKey(id), fetcher: () => fetchRuleBook(id), staleTime: 3000 },
        queries.anchors(id),
        queries.policies(id),
        queries.groups(id),
        queries.ruleSets(id),
      ];
    case 'devices':
      return [queries.devices(id), queries.dashboard(id)];
    case 'chains':
      return [queries.chains(id), queries.groups(id), queries.parsed(id), queries.ruleSummary(id)];
    case 'base':
      return [queries.base(id), queries.groups(id), queries.ruleSummary(id), queries.allRules(id)];
    case 'output':
      return [queries.preview(profile)];
    default:
      return [];
  }
}

function planFor(href: string, active: Profile | null): Plan {
  const path = href.split(/[?#]/)[0];
  const scoped = path.match(/^\/p\/([^/]+)(?:\/([^/]+))?/);
  if (scoped) {
    const name = decodeURIComponent(scoped[1]);
    const profile = getQueryData<Profile[]>(keys.profiles)?.find((p) => p.name === name);
    return profile ? profileSection(scoped[2] ?? '', profile) : [];
  }
  const detail = path.match(/^\/(sources|pools)\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[2]);
    return detail[1] === 'sources'
      ? [queries.source(id), queries.usage('subscription', id)]
      : [queries.pool(id), queries.usage('collection', id)];
  }
  switch (path) {
    case '/sources':
    case '/pools':
      return [queries.sources(), queries.pools(), ...(active ? [queries.meta(active.id)] : [])];
    case '/rule-sets':
      return active
        ? [queries.ruleSets(active.id), queries.meta(active.id), queries.policies(active.id), queries.allRules(active.id)]
        : [];
    case '/history':
      return [{ key: LEDGER_KEY, fetcher: () => fetchLedgerHead() }];
    default:
      return [];
  }
}

export function prefetchHref(href: string, active: Profile | null = null): void {
  for (const q of planFor(href, active)) prefetchQuery(q.key, q.fetcher, q.staleTime);
}

/**
 * Props for a link-like element: prefetch after a short hover (so sweeping the
 * pointer across a menu doesn't fire every item), at once on focus or press.
 */
export function intentProps(href: string, active: Profile | null = null) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const now = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    prefetchHref(href, active);
  };
  return {
    onPointerEnter: () => {
      if (!timer) timer = setTimeout(now, 90);
    },
    onPointerLeave: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    onFocus: now,
    onPointerDown: now,
  };
}
