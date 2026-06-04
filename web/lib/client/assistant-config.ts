'use client';

import { ApiError, api } from '@/lib/client/api';
import { AssistantConfigSchema, type AssistantConfig } from '@/schemas';

/**
 * Browser-side cache of the assistant's DeepSeek config. The agent loop runs
 * in the browser and calls the model API directly, so we cache the config in
 * localStorage and read it per-turn instead of hitting KV every time.
 *
 * Sync model: `loadAssistantConfig()` runs once on page load (from the global
 * AssistantPanel mount), overwriting the cache from KV — so "刷新页面就更新".
 * `getCachedConfig()` is the cheap per-turn read.
 */

const CACHE_KEY = 'pm.assistant.config';

export function getCachedConfig(): AssistantConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = AssistantConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCache(config: AssistantConfig | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (config) window.localStorage.setItem(CACHE_KEY, JSON.stringify(config));
    else window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* quota / private mode — non-fatal, we'll just re-fetch next load */
  }
}

/**
 * Fetch the config from KV and refresh the localStorage cache. Returns the
 * config, or null if not configured yet (404). Other errors are swallowed
 * (returns the existing cache) so a transient API hiccup doesn't wipe usable
 * local state on mount.
 */
export async function loadAssistantConfig(): Promise<AssistantConfig | null> {
  try {
    const res = await api<{ data: AssistantConfig }>('/api/v1/assistant/config');
    const parsed = AssistantConfigSchema.safeParse(res.data);
    const config = parsed.success ? parsed.data : null;
    writeCache(config);
    return config;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      writeCache(null); // not configured — clear any stale cache
      return null;
    }
    return getCachedConfig(); // transient error: keep what we have
  }
}
