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
      type: 'speedtestBatch';
      /**
       * Each target is tested across every group. `label` becomes the result
       * card's `domain` (rule value when the user writes). `url` is passed
       * verbatim to Clash — typically `https://{hostname}/` for host-level
       * checks, or a full URL captured from the tab for path-level checks.
       */
      targets: Array<{ label: string; url: string }>;
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
  | { type: 'pingClash' }
  | { type: 'listRulesByAnchor'; anchor: string };

export interface BackendRule {
  id: string;
  anchor: string;
  type: 'DOMAIN' | 'DOMAIN-SUFFIX' | string;
  value: string;
  policy: string;
}

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
