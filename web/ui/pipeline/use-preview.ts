'use client';

import { useEffect, useRef, useState } from 'react';
import { request } from '@/ui/data/api';
import type { Operator, PipelinePreview } from '@/ui/data/types';

export interface PipelineTarget {
  kind: 'subscription' | 'collection';
  id: string;
}

export function previewPath(target: PipelineTarget): string {
  return `/${target.kind === 'subscription' ? 'subscriptions' : 'collections'}/${target.id}/preview`;
}

export function fetchPreview(target: PipelineTarget, operators: Operator[], signal?: AbortSignal) {
  return request<{ data: PipelinePreview }>(previewPath(target), {
    method: 'POST',
    body: { operators },
    signal,
  }).then((r) => r.data);
}

interface State {
  /** Draft key the data / error belong to. */
  key: string | null;
  data: PipelinePreview | undefined;
  error: unknown;
}

/**
 * Debounced dry-run of a draft pipeline. `operators` must already be a
 * serialised candidate (`stableKey`) so identical drafts never refetch; pass
 * `null` to pause (e.g. while a regex is invalid) — the last result stays
 * visible but is reported as stale.
 */
export function usePipelinePreview(target: PipelineTarget, candidateKey: string | null, delay = 600) {
  const [state, setState] = useState<State>({ key: null, data: undefined, error: undefined });
  const [pending, setPending] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Nothing shown yet → run immediately; afterwards debounce keystrokes.
  const loaded = useRef(false);
  const path = previewPath(target);

  useEffect(() => {
    if (candidateKey === null) {
      setPending(false);
      return;
    }
    const controller = new AbortController();
    const wait = loaded.current ? delay : 0;
    setPending(true);
    const timer = window.setTimeout(() => {
      request<{ data: PipelinePreview }>(path, {
        method: 'POST',
        body: { operators: JSON.parse(candidateKey) as Operator[] },
        signal: controller.signal,
      })
        .then((res) => {
          loaded.current = true;
          setState({ key: candidateKey, data: res.data, error: undefined });
          setPending(false);
        })
        .catch((error: unknown) => {
          if ((error as Error)?.name === 'AbortError') return;
          loaded.current = true;
          setState((current) => ({ key: candidateKey, data: current.data, error }));
          setPending(false);
        });
    }, wait);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [candidateKey, path, delay, nonce]);

  return {
    data: state.data,
    error: state.key === candidateKey ? state.error : undefined,
    /** A request for the current draft is scheduled or in flight. */
    loading: pending,
    /** The visible data was computed for a different draft. */
    stale: state.key !== candidateKey,
    retry: () => setNonce((n) => n + 1),
  };
}
