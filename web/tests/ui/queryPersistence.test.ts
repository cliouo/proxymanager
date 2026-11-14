import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal browser globals: query.ts hydrates from localStorage at import time. */
function installBrowser(adminKey: string | null, store = new Map<string, string>()) {
  if (adminKey) store.set('pm.admin-key', adminKey);
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  vi.stubGlobal('window', { localStorage, addEventListener: () => undefined, dispatchEvent: () => true });
  vi.stubGlobal('document', { addEventListener: () => undefined, visibilityState: 'visible' });
  return store;
}

async function loadQuery() {
  vi.resetModules();
  return import('@/ui/data/query');
}

describe('query cache persistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps read models and skips editor documents', async () => {
    installBrowser('k1');
    const { isPersistedKey } = await loadQuery();
    for (const key of ['workspace-bootstrap', 'sources', 'p:abc:dashboard', 'p:abc:rule-book', 'history:ledger']) {
      expect(isPersistedKey(key), key).toBe(true);
    }
    for (const key of ['p:abc:base', 'source:1', 'pool:1', 'p:abc:device:9', 'assistant-config', 'p:abc:rules?q=x']) {
      expect(isPersistedKey(key), key).toBe(false);
    }
  });

  it('restores persisted data as stale after a reload, for the same admin key only', async () => {
    const store = installBrowser('k1');
    let q = await loadQuery();
    q.setQueryData('sources', [{ id: 's1' }]);
    q.setQueryData('p:abc:base', { yaml: 'x' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.get('pm.query-cache.v1')).toContain('s1');

    // reload, same key: list is back immediately, the editor document is not
    q = await loadQuery();
    expect(q.getQueryData('sources')).toEqual([{ id: 's1' }]);
    expect(q.getQueryData('p:abc:base')).toBeUndefined();

    // reload under another admin key: nothing leaks, the stale cache is dropped
    store.set('pm.admin-key', 'k2');
    q = await loadQuery();
    expect(q.getQueryData('sources')).toBeUndefined();
    expect(store.has('pm.query-cache.v1')).toBe(false);
  });

  it('forgets everything on logout', async () => {
    const store = installBrowser('k1');
    const q = await loadQuery();
    q.setQueryData('profiles', [{ id: 'p' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.has('pm.query-cache.v1')).toBe(true);
    q.clearQueries();
    expect(store.has('pm.query-cache.v1')).toBe(false);
  });
});
