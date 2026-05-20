/**
 * RPC contract between popup/options ↔ background service worker.
 *
 * The SW does all network calls (localhost Clash + remote backend) because
 * chrome extension SWs are not subject to page-origin mixed-content rules,
 * unlike fetch from a popup script running inside an https origin chain.
 */

export type Request =
  | { type: 'listDomains'; tabId: number }
  | { type: 'listUrlsForDomain'; tabId: number; domain: string }
  | { type: 'clearDomains'; tabId: number }
  | { type: 'getPolicies' }
  | { type: 'getAnchors' }
  | {
      type: 'speedtest';
      domains: string[];
      groups: string[];
    }
  | {
      type: 'speedtestExplicit';
      /** Display label for the result card (typically the hostname). */
      label: string;
      /** Full URL to probe — passed verbatim to Clash /proxies/{group}/delay. */
      url: string;
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
  /** Display label — usually the hostname. */
  domain: string;
  /** URL actually probed (helpful when retesting against a specific resource). */
  probedUrl: string;
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
