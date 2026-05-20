/**
 * RPC contract between popup/options ↔ background service worker.
 *
 * The SW does all network calls (localhost Clash + remote backend) because
 * chrome extension SWs are not subject to page-origin mixed-content rules,
 * unlike fetch from a popup script running inside an https origin chain.
 */

export type Request =
  | { type: 'listDomains'; tabId: number }
  | { type: 'clearDomains'; tabId: number }
  | { type: 'getPolicies' }
  | { type: 'getAnchors' }
  | {
      type: 'speedtest';
      domains: string[];
      groups: string[];
    }
  | {
      type: 'createRule';
      anchor: string;
      ruleType: 'DOMAIN' | 'DOMAIN-SUFFIX';
      value: string;
      policy: string;
      note?: string;
    }
  | { type: 'reloadClash' }
  | { type: 'pingBackend' }
  | { type: 'pingClash' };

export interface SpeedtestEntry {
  group: string;
  delayMs: number | null;
  error?: string;
}

export interface SpeedtestForDomain {
  domain: string;
  entries: SpeedtestEntry[];
  best?: SpeedtestEntry;
}

export type Response =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export async function send<T = unknown>(req: Request): Promise<T> {
  const res = (await browser.runtime.sendMessage(req)) as Response;
  if (!res || !res.ok) throw new Error(res?.error ?? 'No response from background');
  return res.data as T;
}
