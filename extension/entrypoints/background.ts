import type {
  Request,
  Response,
  SpeedtestForDomain,
  SpeedtestEntry,
} from "@/lib/messages";
import {
  BackendError,
  backendAnchors,
  backendCreateRule,
  backendCreateRulesBatch,
  backendDeleteRule,
  backendHealth,
  backendListRulesByAnchor,
  backendPolicies,
} from "@/lib/backend";
import { clashDelay, clashPing, clashReload } from "@/lib/clash";
import { getSettings, type Settings } from "@/lib/settings";
import {
  refreshSubscriptionLocally,
  registerSubscriptionRefreshLifecycleCleanup,
  SubscriptionRefreshPhaseError,
} from "@/lib/subscription-refresh";
import {
  ACTIVATION_TTL_MS,
  BridgeSafeError,
  assertBridgeSenderOrigin,
  projectBridgeResult,
  type BridgeSafeErrorCode,
  type BridgeSender,
} from "@/lib/subscription-bridge";

const SKIP_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "about:",
  "edge:",
  "devtools:",
  "data:",
];
const MAX_URLS_PER_HOST = 20;
interface RefreshActivation {
  subscriptionId: string;
  pageOrigin: string;
  tabId: number;
  expiresAt: number;
}

const refreshActivations = new Map<string, RefreshActivation>();

function removeTabActivations(tabId: number): void {
  for (const [token, activation] of refreshActivations) {
    if (activation.tabId === tabId) refreshActivations.delete(token);
  }
}

function issueRefreshActivation(
  subscriptionId: string,
  pageOrigin: string,
  tabId: number,
): string {
  removeTabActivations(tabId);
  const token = crypto.randomUUID();
  refreshActivations.set(token, {
    subscriptionId,
    pageOrigin,
    tabId,
    expiresAt: Date.now() + ACTIVATION_TTL_MS,
  });
  return token;
}

function consumeRefreshActivation(
  token: string,
  subscriptionId: string,
  pageOrigin: string,
  tabId: number,
): boolean {
  const activation = refreshActivations.get(token);
  refreshActivations.delete(token);
  return Boolean(
    activation &&
    activation.subscriptionId === subscriptionId &&
    activation.pageOrigin === pageOrigin &&
    activation.tabId === tabId &&
    Date.now() <= activation.expiresAt,
  );
}

function isBridgeRequest(req: Request): boolean {
  return (
    req.type === "subscriptionBridgeStatus" ||
    req.type === "issueSubscriptionRefreshActivation" ||
    req.type === "refreshSubscriptionLocally"
  );
}

function safeBridgeError(error: unknown): BridgeSafeErrorCode {
  if (error instanceof SubscriptionRefreshPhaseError) {
    return error.phase === "definite-pre-upload"
      ? "fetch-failed"
      : "upload-failed";
  }
  if (error instanceof BridgeSafeError) return error.code;
  if (error instanceof BackendError && error.status === 412)
    return "concurrent-update";
  return "outcome-ambiguous";
}

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
    { urls: ["<all_urls>"] },
    [],
  );

  browser.webNavigation?.onCommitted?.addListener?.((details) => {
    if (details.frameId === 0) perTabHostUrls.delete(details.tabId);
  });

  browser.tabs.onRemoved.addListener((tabId: number) => {
    perTabHostUrls.delete(tabId);
    removeTabActivations(tabId);
  });

  registerSubscriptionRefreshLifecycleCleanup(
    (listener) => browser.runtime.onStartup.addListener(listener),
    (listener) => browser.runtime.onInstalled.addListener(listener),
    () => refreshActivations.clear(),
  );

  browser.runtime.onMessage.addListener(
    async (message: unknown, sender): Promise<Response> => {
      const request = message as Request;
      try {
        const data = await handle(request, sender);
        return { ok: true, data };
      } catch (error) {
        return {
          ok: false,
          error: isBridgeRequest(request)
            ? safeBridgeError(error)
            : error instanceof Error
              ? error.message
              : String(error),
        };
      }
    },
  );
});

async function handle(req: Request, sender?: BridgeSender): Promise<unknown> {
  switch (req.type) {
    case "listDomains": {
      const map = perTabHostUrls.get(req.tabId);
      return map ? [...map.keys()].sort() : [];
    }
    case "listUrlsForDomain": {
      const map = perTabHostUrls.get(req.tabId);
      const urls = map?.get(req.domain);
      return urls ? [...urls] : [];
    }
    case "clearDomains": {
      perTabHostUrls.delete(req.tabId);
      return null;
    }
    case "getPolicies": {
      const settings = await getSettings();
      return backendPolicies(settings);
    }
    case "getAnchors": {
      const settings = await getSettings();
      return backendAnchors(settings);
    }
    case "speedtestBatch": {
      const settings = await getSettings();
      const results: SpeedtestForDomain[] = [];
      for (const target of req.targets) {
        results.push(
          await runOneSpeedtest(settings, target.label, target.url, req.groups),
        );
      }
      return results;
    }
    case "createRule": {
      const settings = await getSettings();
      return backendCreateRule(settings, {
        anchor: req.anchor,
        type: req.ruleType,
        value: req.value,
        policy: req.policy,
        source: "speedtest",
        note: req.note,
      });
    }
    case "reloadClash": {
      const settings = await getSettings();
      await clashReload(settings);
      return null;
    }
    case "pingBackend": {
      const settings = await getSettings();
      return backendHealth(settings);
    }
    case "pingClash": {
      const settings = await getSettings();
      return clashPing(settings);
    }
    case "subscriptionBridgeStatus": {
      const settings = await getSettings();
      if (!settings.backendUrl || !settings.adminKey || !sender) {
        throw new BridgeSafeError("origin-mismatch");
      }
      assertBridgeSenderOrigin(
        settings,
        req.pageOrigin,
        sender,
        browser.runtime.id,
      );
      return { ready: true };
    }
    case "issueSubscriptionRefreshActivation": {
      const settings = await getSettings();
      if (!settings.backendUrl || !settings.adminKey) {
        throw new BridgeSafeError("extension-not-configured");
      }
      if (
        !sender ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          req.subscriptionId,
        )
      ) {
        throw new BridgeSafeError("invalid-request");
      }
      assertBridgeSenderOrigin(
        settings,
        req.pageOrigin,
        sender,
        browser.runtime.id,
      );
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId))
        throw new BridgeSafeError("origin-mismatch");
      return {
        activation: issueRefreshActivation(
          req.subscriptionId,
          req.pageOrigin,
          tabId as number,
        ),
      };
    }
    case "refreshSubscriptionLocally": {
      const settings = await getSettings();
      if (!settings.backendUrl || !settings.adminKey) {
        throw new BridgeSafeError("extension-not-configured");
      }
      if (
        !sender ||
        typeof req.activation !== "string" ||
        req.activation.length > 128
      ) {
        throw new BridgeSafeError("invalid-request");
      }
      assertBridgeSenderOrigin(
        settings,
        req.pageOrigin,
        sender,
        browser.runtime.id,
      );
      const tabId = sender.tab?.id;
      if (
        !Number.isInteger(tabId) ||
        !consumeRefreshActivation(
          req.activation,
          req.subscriptionId,
          req.pageOrigin,
          tabId as number,
        )
      ) {
        throw new BridgeSafeError("activation-required");
      }
      return projectBridgeResult(
        "refresh",
        await refreshSubscriptionLocally(settings, req.subscriptionId),
      );
    }
    case "listRulesByAnchor": {
      const settings = await getSettings();
      return backendListRulesByAnchor(settings, req.anchor);
    }
    case "deleteRule": {
      const settings = await getSettings();
      await backendDeleteRule(settings, req.ruleId);
      return null;
    }
    case "createRulesBatch": {
      const settings = await getSettings();
      return backendCreateRulesBatch(
        settings,
        req.rules.map((rule) => ({
          anchor: rule.anchor,
          type: rule.ruleType,
          value: rule.value,
          policy: rule.policy,
          source: "speedtest",
          note: rule.note,
        })),
      );
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
