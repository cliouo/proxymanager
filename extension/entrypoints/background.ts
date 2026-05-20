import type { Request, Response, SpeedtestForDomain, SpeedtestEntry } from '@/lib/messages';
import {
  backendAnchors,
  backendCreateRule,
  backendHealth,
  backendPolicies,
} from '@/lib/backend';
import { clashDelay, clashPing, clashReload } from '@/lib/clash';
import { getSettings } from '@/lib/settings';

const SKIP_SCHEMES = ['chrome:', 'chrome-extension:', 'about:', 'edge:', 'devtools:', 'data:'];

// Tab id → set of hostnames observed since the last main_frame navigation.
const perTabDomains = new Map<number, Set<string>>();

function tabKey(tabId: number): Set<string> {
  let set = perTabDomains.get(tabId);
  if (!set) {
    set = new Set();
    perTabDomains.set(tabId, set);
  }
  return set;
}

function recordRequest(tabId: number, urlStr: string): void {
  if (tabId < 0) return; // -1 = service worker or background page
  try {
    const u = new URL(urlStr);
    if (SKIP_SCHEMES.includes(u.protocol)) return;
    if (!u.hostname) return;
    tabKey(tabId).add(u.hostname);
  } catch {
    /* invalid URL — ignore */
  }
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
    if (details.frameId === 0) perTabDomains.delete(details.tabId);
  });

  browser.tabs.onRemoved.addListener((tabId: number) => {
    perTabDomains.delete(tabId);
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
      const set = perTabDomains.get(req.tabId);
      return set ? [...set].sort() : [];
    }
    case 'clearDomains': {
      perTabDomains.delete(req.tabId);
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
      return runSpeedtest(req.domains, req.groups);
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

async function runSpeedtest(
  domains: string[],
  groups: string[],
): Promise<SpeedtestForDomain[]> {
  const settings = await getSettings();
  const results: SpeedtestForDomain[] = [];

  for (const domain of domains) {
    const testUrl = `https://${domain}/`;
    const entries: SpeedtestEntry[] = await Promise.all(
      groups.map(async (group) => {
        try {
          const delayMs = await clashDelay(
            settings,
            group,
            testUrl,
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
    results.push({ domain, entries, best: reachable[0] });
  }

  return results;
}
