'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getAdminKey, withLowPriority } from './api';

/**
 * A deliberately small stale-while-revalidate cache.
 *
 *  - one entry per string key, in-flight requests are de-duplicated;
 *  - components subscribe with useSyncExternalStore (no provider needed);
 *  - `invalidate()` marks matching keys stale and refetches the mounted ones;
 *  - window focus revalidates anything older than a few seconds.
 */

type Status = 'idle' | 'loading' | 'success' | 'error';

interface Entry<T = unknown> {
  data: T | undefined;
  error: unknown;
  status: Status;
  updatedAt: number;
  promise: Promise<T> | null;
  fetcher: (() => Promise<T>) | null;
  listeners: Set<() => void>;
  version: number;
}

const entries = new Map<string, Entry>();

function entryFor<T>(key: string): Entry<T> {
  let entry = entries.get(key) as Entry<T> | undefined;
  if (!entry) {
    entry = {
      data: undefined,
      error: undefined,
      status: 'idle',
      updatedAt: 0,
      promise: null,
      fetcher: null,
      listeners: new Set(),
      version: 0,
    };
    entries.set(key, entry as Entry);
  }
  return entry;
}

function notify(entry: Entry): void {
  entry.version++;
  for (const listener of entry.listeners) listener();
}

/* ─── persistence ─────────────────────────────────────────────────────
 * List/overview data survives reloads in localStorage, so a cold load
 * paints last session's view at once and revalidates in the background
 * (stale-while-revalidate). Only read models are kept: editors that seed a
 * draft from their document (base YAML, source pipeline, device detail …)
 * always start from a fresh fetch, and every write already carries a
 * version/revision so a briefly stale list can't overwrite newer data.
 * The cache is bound to the admin key it was fetched with (the key itself
 * already lives in localStorage) and cleared on logout.
 */

const STORE_KEY = 'pm.query-cache.v1';
const STORE_MAX_AGE = 7 * 24 * 3600_000;
const ENTRY_MAX_CHARS = 400_000;
const STORE_MAX_CHARS = 2_500_000;

const PERSISTED = [
  /^(workspace-bootstrap|profiles|setup|sources|pools|templates|history:ledger)$/,
  /^p:[^:]+:(dashboard|meta|groups|groups-book|policies|anchors|rule-summary|rule-sets|rule-book|rules-all|devices|chains|preview|summary)$/,
];

export function isPersistedKey(key: string): boolean {
  return PERSISTED.some((pattern) => pattern.test(key));
}

/** FNV-1a: enough to tell admin keys apart without storing one twice. */
function ownerTag(): string | null {
  const secret = getAdminKey();
  if (!secret) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

interface Stored {
  owner: string;
  savedAt: number;
  entries: Record<string, unknown>;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function writeStore(): void {
  persistTimer = null;
  const owner = ownerTag();
  if (!owner) return;
  const rows: Array<[string, string]> = [];
  for (const [key, entry] of entries) {
    if (entry.status !== 'success' || entry.data === undefined || !isPersistedKey(key)) continue;
    const json = JSON.stringify(entry.data);
    if (json.length <= ENTRY_MAX_CHARS) rows.push([key, json]);
  }
  // Over budget: drop the biggest entries (rendered previews) first.
  rows.sort((a, b) => a[1].length - b[1].length);
  let total = 0;
  const kept = rows.filter(([, json]) => (total += json.length) <= STORE_MAX_CHARS);
  const body = `{"owner":${JSON.stringify(owner)},"savedAt":${Date.now()},"entries":{${kept
    .map(([key, json]) => `${JSON.stringify(key)}:${json}`)
    .join(',')}}}`;
  try {
    window.localStorage.setItem(STORE_KEY, body);
  } catch {
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      /* storage unavailable */
    }
  }
}

function schedulePersist(key: string): void {
  if (typeof window === 'undefined' || !isPersistedKey(key) || persistTimer) return;
  persistTimer = setTimeout(writeStore, 800);
}

function hydrate(): void {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const stored = JSON.parse(raw) as Stored;
    if (stored.owner !== ownerTag() || Date.now() - stored.savedAt > STORE_MAX_AGE) {
      window.localStorage.removeItem(STORE_KEY);
      return;
    }
    for (const [key, data] of Object.entries(stored.entries)) {
      if (!isPersistedKey(key)) continue;
      const entry = entryFor(key);
      entry.data = data;
      entry.status = 'success';
      // updatedAt 0 = stale: shown immediately, refetched as soon as it mounts.
      entry.updatedAt = 0;
    }
  } catch {
    window.localStorage.removeItem(STORE_KEY);
  }
}

if (typeof window !== 'undefined') hydrate();

export function fetchQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  force = false,
  start: (fetcher: () => Promise<T>) => Promise<T> = (f) => f(),
): Promise<T> {
  const entry = entryFor<T>(key);
  entry.fetcher = fetcher;
  if (entry.promise && !force) return entry.promise;
  const promise = start(fetcher).then(
    (data) => {
      if (entry.promise === promise) {
        entry.data = data;
        entry.error = undefined;
        entry.status = 'success';
        entry.updatedAt = Date.now();
        entry.promise = null;
        notify(entry as Entry);
        schedulePersist(key);
      }
      return data;
    },
    (error: unknown) => {
      if (entry.promise === promise) {
        entry.error = error;
        entry.status = 'error';
        entry.promise = null;
        notify(entry as Entry);
      }
      throw error;
    },
  );
  entry.promise = promise;
  if (entry.status !== 'success') entry.status = 'loading';
  notify(entry as Entry);
  return promise;
}

export function getQueryData<T>(key: string): T | undefined {
  return entries.get(key)?.data as T | undefined;
}

export function setQueryData<T>(key: string, updater: T | ((current: T | undefined) => T)): void {
  const entry = entryFor<T>(key);
  entry.data =
    typeof updater === 'function' ? (updater as (current: T | undefined) => T)(entry.data) : updater;
  entry.status = 'success';
  entry.error = undefined;
  entry.updatedAt = Date.now();
  notify(entry as Entry);
  schedulePersist(key);
}

type Matcher = string | RegExp | ((key: string) => boolean);

function matches(key: string, matcher: Matcher): boolean {
  if (typeof matcher === 'string') return key === matcher || key.startsWith(`${matcher}`);
  if (matcher instanceof RegExp) return matcher.test(key);
  return matcher(key);
}

/** Mark matching keys stale; mounted ones refetch immediately. */
export function invalidate(...matchers: Matcher[]): void {
  for (const [key, entry] of entries) {
    if (!matchers.some((m) => matches(key, m))) continue;
    entry.updatedAt = 0;
    if (entry.listeners.size > 0 && entry.fetcher) {
      fetchQuery(key, entry.fetcher, true).catch(() => undefined);
    }
  }
}

/** Drop everything (used on logout). */
export function clearQueries(): void {
  entries.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable / SSR */
  }
}

/** Start loading a key ahead of need (hover/focus intent); no-op while fresh. */
export function prefetchQuery<T>(key: string, fetcher: () => Promise<T>, staleTime = 4000): void {
  const entry = entryFor<T>(key);
  if (entry.promise) return;
  if (entry.status === 'success' && Date.now() - entry.updatedAt < staleTime) return;
  // Speculative: sent at low fetch priority (the entry keeps the plain fetcher
  // for later revalidation).
  fetchQuery(key, fetcher, false, (f) => withLowPriority(f)).catch(() => undefined);
}

if (typeof window !== 'undefined') {
  const revalidateActive = () => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.listeners.size > 0 && entry.fetcher && now - entry.updatedAt > 5000) {
        fetchQuery(key, entry.fetcher).catch(() => undefined);
      }
    }
  };
  window.addEventListener('focus', revalidateActive);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') revalidateActive();
  });
}

export interface QueryOptions {
  /** ms a cached value counts as fresh on mount (default 4s). */
  staleTime?: number;
  /** Keep showing the previous key's data while the next key loads. */
  keepPrevious?: boolean;
  /** Poll every n ms while mounted. */
  refreshInterval?: number;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  /** True only while there is nothing to show yet. */
  isLoading: boolean;
  /** True whenever a request for this key is in flight. */
  isValidating: boolean;
  refetch: () => Promise<T | undefined>;
  mutate: (updater: T | ((current: T | undefined) => T)) => void;
}

const noopSubscribe = () => () => undefined;

/** Layout effect on the client (runs before passive effects), plain effect during SSR. */
export const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: QueryOptions = {},
): QueryResult<T> {
  const { staleTime = 4000, keepPrevious = false, refreshInterval } = options;
  const fetcherRef = useRef(fetcher);
  useIsomorphicLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });
  const stableFetcher = useCallback(() => fetcherRef.current(), []);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => undefined;
      const entry = entryFor<T>(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [key],
  );

  useSyncExternalStore(
    key ? subscribe : noopSubscribe,
    () => (key ? entryFor<T>(key).version : -1),
    () => -1,
  );

  useEffect(() => {
    if (!key) return;
    const entry = entryFor<T>(key);
    entry.fetcher = stableFetcher;
    const fresh = entry.status === 'success' && Date.now() - entry.updatedAt < staleTime;
    if (!fresh) fetchQuery(key, stableFetcher).catch(() => undefined);
  }, [key, staleTime, stableFetcher]);

  useEffect(() => {
    if (!key || !refreshInterval) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchQuery(key, stableFetcher).catch(() => undefined);
      }
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [key, refreshInterval, stableFetcher]);

  const entry = key ? entryFor<T>(key) : null;
  const current = entry?.data;
  // Derived state (not a ref): remember the last loaded value while the next key loads.
  const [previous, setPrevious] = useState<T | undefined>(undefined);
  if (keepPrevious && current !== undefined && current !== previous) setPrevious(current);
  const data = current ?? (keepPrevious ? previous : undefined);

  const refetch = useCallback(async () => {
    if (!key) return undefined;
    try {
      return await fetchQuery(key, stableFetcher, true);
    } catch {
      return undefined;
    }
  }, [key, stableFetcher]);

  const mutate = useCallback(
    (updater: T | ((current: T | undefined) => T)) => {
      if (key) setQueryData<T>(key, updater);
    },
    [key],
  );

  return {
    data,
    error: entry?.error,
    isLoading: data === undefined && (entry?.status === 'loading' || entry?.status === 'idle') && !!key,
    isValidating: !!entry?.promise,
    refetch,
    mutate,
  };
}
