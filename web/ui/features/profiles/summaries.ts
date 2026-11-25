'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/ui/data/api';
import { keys } from '@/ui/data/hooks';
import { useQuery } from '@/ui/data/query';
import type { ProfileCardSummary } from '@/ui/data/types';

/** Max ids per HTTP request (server enforces <= 8). */
const BATCH_SIZE = 6;
/** Max concurrent summary batch requests so the browser's 6-connection pool stays free for navigation. */
const MAX_CONCURRENT_BATCHES = 2;
/** Short coalesce window to group cards mounting in the same frame/scroll. */
const FLUSH_DELAY_MS = 25;

interface PendingEntry {
  promise: Promise<ProfileCardSummary>;
  resolve: (value: ProfileCardSummary) => void;
  reject: (reason: unknown) => void;
}

const queued = new Map<string, PendingEntry>();
const readyChunks: string[][] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inflightBatches = 0;

function drainChunks(): void {
  while (inflightBatches < MAX_CONCURRENT_BATCHES && readyChunks.length > 0) {
    const chunk = readyChunks.shift()!;
    const batch = chunk
      .map((id) => ({ id, entry: queued.get(id) }))
      .filter((item): item is { id: string; entry: PendingEntry } => !!item.entry);
    if (batch.length === 0) continue;
    for (const item of batch) queued.delete(item.id);

    inflightBatches += 1;
    api
      .get<Record<string, ProfileCardSummary>>('/profiles/summaries', {
        ids: batch.map((item) => item.id).join(','),
      })
      .then(
        (map) => {
          for (const { id, entry } of batch) {
            const summary = map?.[id];
            if (summary) {
              entry.resolve(summary);
            } else {
              entry.resolve({
                groupsCount: 0,
                rankedGroupNames: [],
                activeRules: 0,
                disabledRules: 0,
                policies: {},
                devicesCount: 0,
              });
            }
          }
        },
        (error) => {
          for (const { entry } of batch) entry.reject(error);
        },
      )
      .finally(() => {
        inflightBatches -= 1;
        drainChunks();
      });
  }
}

function flushQueue(): void {
  flushTimer = null;
  const ids = [...queued.keys()];
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    readyChunks.push(ids.slice(i, i + BATCH_SIZE));
  }
  drainChunks();
}

export function loadProfileSummaryBatched(profileId: string): Promise<ProfileCardSummary> {
  const existing = queued.get(profileId);
  if (existing) return existing.promise;

  let resolve!: (value: ProfileCardSummary) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ProfileCardSummary>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  queued.set(profileId, { promise, resolve, reject });

  if (!flushTimer) {
    flushTimer = setTimeout(flushQueue, FLUSH_DELAY_MS);
  }
  return promise;
}

export function useProfileSummary(profileId: string, enabled: boolean) {
  return useQuery<ProfileCardSummary>(
    enabled ? keys.scoped(profileId, 'summary') : null,
    () => loadProfileSummaryBatched(profileId),
    { staleTime: 15_000 },
  );
}

/**
 * Latch `visible` to true once a card enters (or approaches within 240px of) the viewport.
 * Falls back to `true` when IntersectionObserver is unavailable (e.g. jsdom / SSR).
 */
export function useNearViewport(): [(node: Element | null) => void, boolean] {
  const [node, setNode] = useState<Element | null>(null);
  const [visible, setVisible] = useState(
    () => typeof window === 'undefined' || typeof IntersectionObserver === 'undefined',
  );

  const ref = useCallback((el: Element | null) => {
    setNode(el);
  }, []);

  useEffect(() => {
    if (visible || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, visible]);

  return [ref, visible];
}
