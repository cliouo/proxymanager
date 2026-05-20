/**
 * Append-only log of recent rule writes initiated from the extension.
 *
 * Stored under chrome.storage.local. Ring buffer capped at MAX entries —
 * older entries are dropped silently. This is purely client-side so it can
 * survive popup close/reopen without round-tripping the backend.
 */

export interface RecentWrite {
  id: string;
  ts: number;
  anchor: string;
  ruleType: 'DOMAIN' | 'DOMAIN-SUFFIX';
  value: string;
  policy: string;
  /** Backend-assigned rule id when available — enables future undo. */
  ruleId?: string;
  /** Whether auto-reload of Clash fired successfully after this write. */
  reloaded: boolean;
  /**
   * Set after the user clicks Undo on this entry. Presence implies the rule
   * has been DELETEd from the backend; entries without ruleId can't be undone
   * (older log entries before ruleId capture).
   */
  undone?: {
    ts: number;
    reloaded: boolean;
    error?: string;
  };
}

const KEY = 'proxymanager.recentWrites';
const MAX = 20;

export async function getRecentWrites(): Promise<RecentWrite[]> {
  const result = await browser.storage.local.get(KEY);
  const raw = result[KEY];
  if (!Array.isArray(raw)) return [];
  return raw as RecentWrite[];
}

export async function pushRecentWrite(entry: RecentWrite): Promise<RecentWrite[]> {
  const list = await getRecentWrites();
  const next = [entry, ...list].slice(0, MAX);
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export async function clearRecentWrites(): Promise<void> {
  await browser.storage.local.set({ [KEY]: [] });
}

export async function updateRecentWrite(
  id: string,
  patch: Partial<RecentWrite>,
): Promise<RecentWrite[]> {
  const list = await getRecentWrites();
  const next = list.map((w) => (w.id === id ? { ...w, ...patch } : w));
  await browser.storage.local.set({ [KEY]: next });
  return next;
}
