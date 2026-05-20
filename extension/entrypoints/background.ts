import type { Request, Response, SpeedtestForDomain, SpeedtestEntry } from '@/lib/messages';
import {
  backendAnchors,
  backendCreateRule,
  backendHealth,
  backendPolicies,
} from '@/lib/backend';
import { clashDelay, clashPing, clashReload } from '@/lib/clash';
import { getSettings, type Settings } from '@/lib/settings';

const SKIP_SCHEMES = ['chrome:', 'chrome-extension:', 'about:', 'edge:', 'devtools:', 'data:'];
const MAX_URLS_PER_HOST = 20;

// Tab id → (hostname → list of distinct full URLs observed since the last
// main_frame navigation). Distinctness is keyed by `origin + pathname` so
// e.g. `/api/users?token=A` and `/api/users?token=B` collapse into one entry,
// but `/api/users` and `/img/logo.png` remain separate. The full URL
// (including query) is preserved so the speedtest hits the exact resource.
const perTabHostUrls = new Map<number, Map<string, string[]>>();

function recordRequest(tabId: number, urlStr: string): void {
  if (tabId < 0) return;
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return;
  }
  if (SKIP_SCHEMES.includes(u.protocol)) return;
  if (!u.hostname) return;

  let hostMap = perTabHostUrls.get(tabId);
  if (!hostMap) {
    hostMap = new Map();
    perTabHostUrls.set(tabId, hostMap);
  }

  let urls = hostMap.get(u.hostname);
  if (!urls) {
    urls = [];
    hostMap.set(u.hostname, urls);
  }

  const key = u.origin + u.pathname;
  for (const existing of urls) {
    try {
      const e = new URL(existing);
      if (e.origin + e.pathname === key) return;
    } catch {
      /* ignore */
    }
  }

  urls.push(urlStr);
  if (urls.length > MAX_URLS_PER_HOST) urls.shift();
}

export default defineBackground(() => {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      recordRequest(details.tabId, details.url);
      return undefined;
    },
    { urls: ['<all_urls>'] },
    [],
  );

  browser.webNavigation?.onCommitted?.addListener?.((details) => {
    if (details.frameId === 0) perTabHostUrls.delete(details.tabId);
  });

  browser.tabs.onRemoved.addListener((tabId: number) => {
    perTabHostUrls.delete(tabId);
  });

  browser.runtime.onMessage.addListener(async (message: unknown): Promise<Response> => {
    try {
      const data = await handle(message as Request);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
});

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'listDomains': {
      const map = perTabHostUrls.get(req.tabId);
      return map ? [...map.keys()].sort() : [];
    }
    case 'listUrlsForDomain': {
      const map = perTabHostUrls.get(req.tabId);
      const urls = map?.get(req.domain);
      return urls ? [...urls] : [];
    }
    case 'clearDomains': {
      perTabHostUrls.delete(req.tabId);
      return null;
    }
    case 'getPolicies': {
      const settings = await getSettings();
      return backendPolicies(settings);
    }
    case 'getAnchors': {
      const settings = await getSettings();
      return backendAnchors(settings);
    }
    case 'speedtest': {
      const settings = await getSettings();
      const results: SpeedtestForDomain[] = [];
      for (const domain of req.domains) {
        const probedUrl = `https://${domain}/`;
        results.push(await runOneSpeedtest(settings, domain, probedUrl, req.groups));
      }
      return results;
    }
    case 'speedtestExplicit': {
      const settings = await getSettings();
      return runOneSpeedtest(settings, req.label, req.url, req.groups);
    }
    case 'createRule': {
      const settings = await getSettings();
      return backendCreateRule(settings, {
        anchor: req.anchor,
        type: req.ruleType,
        value: req.value,
        policy: req.policy,
        source: 'speedtest',
        note: req.note,
      });
    }
    case 'reloadClash': {
      const settings = await getSettings();
      await clashReload(settings);
      return null;
    }
    case 'pingBackend': {
      const settings = await getSettings();
      return backendHealth(settings);
    }
    case 'pingClash': {
      const settings = await getSettings();
      return clashPing(settings);
    }
  }
}

async function runOneSpeedtest(
  settings: Settings,
  label: string,
  probedUrl: string,
  groups: string[],
): Promise<SpeedtestForDomain> {
  const entries: SpeedtestEntry[] = await Promise.all(
    groups.map(async (group) => {
      try {
        const delayMs = await clashDelay(
          settings,
          group,
          probedUrl,
          settings.speedtestTimeoutMs,
        );
        return { group, delayMs };
      } catch (err) {
        return {
          group,
          delayMs: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const reachable = entries.filter((e) => e.delayMs !== null && e.delayMs > 0);
  reachable.sort((a, b) => (a.delayMs ?? 0) - (b.delayMs ?? 0));
  return { domain: label, probedUrl, entries, best: reachable[0] };
}
