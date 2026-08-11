import { browser } from "wxt/browser";
import {
  BackendError,
  backendImportManualSubscription,
  backendSubscriptionLocalFetchSpec,
  type SubscriptionLocalFetchSpec,
} from "./backend";
import type { Settings } from "./settings";

const MAX_SUBSCRIPTION_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: Record<number, true> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

export const DNR_USER_AGENT_RULE_ID = 19_120_417;

interface SessionRule {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: Array<{
      header: string;
      operation: "set";
      value: string;
    }>;
  };
  condition: {
    regexFilter: string;
    resourceTypes: ["xmlhttprequest"];
    initiatorDomains: [string];
  };
}
interface WebRequestDetails {
  requestId: string;
  url: string;
  type: string;
  initiator?: string;
  statusCode?: number;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

interface WebRequestEvent {
  addListener(
    callback: (details: WebRequestDetails) => void,
    filter: { urls: string[]; types?: string[] },
    extraInfoSpec?: string[],
  ): void;
  removeListener(callback: (details: WebRequestDetails) => void): void;
}

interface RedirectObserver {
  onBeforeRequest: WebRequestEvent;
  onHeadersReceived: WebRequestEvent;
}

interface FetchHopResult {
  response: Response;
  redirectUrl?: string;
}

export interface SubscriptionRefreshDependencies {
  extensionId: string;
  getSpec: (
    settings: Settings,
    subscriptionId: string,
  ) => Promise<SubscriptionLocalFetchSpec>;
  upload: (
    settings: Settings,
    spec: SubscriptionLocalFetchSpec,
    content: string,
  ) => Promise<{ proxyCount: number; updatedAt: number }>;
  fetchImpl: typeof fetch;
  updateSessionRules: (options: {
    removeRuleIds: number[];
    addRules?: SessionRule[];
  }) => Promise<void>;
  fetchHop?: (url: string, init: RequestInit) => Promise<FetchHopResult>;
}

export interface LocalSubscriptionRefreshReceipt {
  proxyCount: number;
  updatedAt: number;
}

export type SubscriptionRefreshFailurePhase =
  | "definite-pre-upload"
  | "ambiguous-or-post-upload";

/** Fixed, secret-free phase signal consumed by the trusted bridge boundary. */
export class SubscriptionRefreshPhaseError extends Error {
  constructor(public readonly phase: SubscriptionRefreshFailurePhase) {
    super(phase === "definite-pre-upload" ? "fetch-failed" : "upload-failed");
    this.name = "SubscriptionRefreshPhaseError";
  }
}

export function escapeDnrRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildUserAgentSessionRule(
  url: string,
  userAgent: string,
  extensionId: string,
): SessionRule {
  return {
    id: DNR_USER_AGENT_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "User-Agent", operation: "set", value: userAgent },
      ],
    },
    condition: {
      regexFilter: `^${escapeDnrRegex(url)}$`,
      resourceTypes: ["xmlhttprequest"],
      initiatorDomains: [extensionId],
    },
  };
}

function assertHttpUrl(raw: string, base?: URL): URL {
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error("invalid-url");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("invalid-url");
  }
  parsed.hash = "";
  return parsed;
}

function requestHeaders(
  spec: SubscriptionLocalFetchSpec,
  includeSensitive: boolean,
): Headers {
  let headers: Headers;
  try {
    headers = new Headers(includeSensitive ? spec.customHeaders : undefined);
  } catch {
    throw new Error("invalid-headers");
  }
  headers.delete("User-Agent");
  if (!headers.has("Accept")) headers.set("Accept", "*/*");
  return headers;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedUtf8(response: Response): Promise<string> {
  const declaredRaw = response.headers.get("content-length");
  if (declaredRaw && /^(0|[1-9][0-9]*)$/.test(declaredRaw)) {
    const declared = Number(declaredRaw);
    if (Number.isSafeInteger(declared) && declared > MAX_SUBSCRIPTION_BYTES) {
      await cancelBody(response);
      throw new Error("response-too-large");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      size += next.value.byteLength;
      if (size > MAX_SUBSCRIPTION_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("response-invalid-utf8");
  }
}

async function cleanupUserAgentRule(
  updateSessionRules: SubscriptionRefreshDependencies["updateSessionRules"],
): Promise<void> {
  await updateSessionRules({ removeRuleIds: [DNR_USER_AGENT_RULE_ID] });
}

function isExactExtensionInitiator(
  raw: string | undefined,
  extensionId: string,
): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === "chrome-extension:" &&
      parsed.hostname === extensionId &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Chromium exposes manual redirects to Fetch as opaque responses. Correlate
 * the exact extension-initiated request id and observe its response headers so
 * Location is never guessed and custom headers can be dropped before the next
 * explicitly issued hop.
 */
export async function fetchHopWithRedirectObserver(
  url: string,
  init: RequestInit,
  extensionId: string,
  fetchImpl: typeof fetch,
  webRequest: RedirectObserver,
): Promise<FetchHopResult> {
  let requestId: string | null = null;
  let observedRedirect: string | undefined;
  let resolveRedirect: ((url: string) => void) | undefined;
  const redirectObserved = new Promise<string>((resolve) => {
    resolveRedirect = resolve;
  });
  const onBeforeRequest = (details: WebRequestDetails) => {
    if (
      requestId === null &&
      details.url === url &&
      details.type === "xmlhttprequest" &&
      isExactExtensionInitiator(details.initiator, extensionId)
    ) {
      requestId = details.requestId;
    }
  };
  const onHeadersReceived = (details: WebRequestDetails) => {
    if (
      requestId === null ||
      details.requestId !== requestId ||
      details.url !== url ||
      details.statusCode === undefined ||
      !REDIRECT_STATUSES[details.statusCode]
    ) {
      return;
    }
    const location = details.responseHeaders?.find(
      (header) => header.name.toLowerCase() === "location",
    )?.value;
    if (location) {
      observedRedirect = location;
      resolveRedirect?.(location);
    }
  };
  const filter = { urls: ["<all_urls>"], types: ["xmlhttprequest"] };
  webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
  webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, [
    "responseHeaders",
    "extraHeaders",
  ]);
  try {
    const response = await fetchImpl(url, init);
    if (
      (response.type === "opaqueredirect" || response.status === 0) &&
      !observedRedirect
    ) {
      let timer: number | undefined;
      try {
        observedRedirect = await Promise.race([
          redirectObserved,
          new Promise<undefined>((resolve) => {
            timer = globalThis.setTimeout(resolve, 250);
          }),
        ]);
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    return observedRedirect
      ? { response, redirectUrl: observedRedirect }
      : { response };
  } finally {
    webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  }
}

async function fetchThroughLocalNetwork(
  spec: SubscriptionLocalFetchSpec,
  dependencies: SubscriptionRefreshDependencies,
): Promise<string> {
  let currentUrl = assertHttpUrl(spec.url);
  const initialOrigin = currentUrl.origin;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS,
  );
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await dependencies.updateSessionRules({
        removeRuleIds: [DNR_USER_AGENT_RULE_ID],
        addRules: [
          buildUserAgentSessionRule(
            currentUrl.href,
            spec.userAgent,
            dependencies.extensionId,
          ),
        ],
      });
      const init: RequestInit = {
        method: "GET",
        headers: requestHeaders(spec, currentUrl.origin === initialOrigin),
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      };
      const { response, redirectUrl } = dependencies.fetchHop
        ? await dependencies.fetchHop(currentUrl.href, init)
        : { response: await dependencies.fetchImpl(currentUrl.href, init) };
      if (redirectUrl || REDIRECT_STATUSES[response.status]) {
        await cancelBody(response);
        if (hop === MAX_REDIRECTS) throw new Error("redirect-limit");
        const location = redirectUrl ?? response.headers.get("location");
        if (!location) throw new Error("redirect-invalid");
        const nextUrl = assertHttpUrl(location, currentUrl);
        if (nextUrl.origin !== initialOrigin) {
          throw new Error("redirect-origin-mismatch");
        }
        currentUrl = nextUrl;
        continue;
      }
      if (response.type === "opaqueredirect" || response.status === 0) {
        await cancelBody(response);
        throw new Error("redirect-invalid");
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new Error("upstream-http");
      }
      return await readBoundedUtf8(response);
    }
    throw new Error("redirect-limit");
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function defaultDependencies(): SubscriptionRefreshDependencies {
  const fetchImpl = globalThis.fetch.bind(globalThis);
  return {
    extensionId: browser.runtime.id,
    getSpec: backendSubscriptionLocalFetchSpec,
    upload: async (settings, spec, content) => {
      const result = await backendImportManualSubscription(
        settings,
        spec,
        content,
      );
      return result.data;
    },
    fetchImpl,
    updateSessionRules: (options) =>
      browser.declarativeNetRequest.updateSessionRules(options),
    fetchHop: (url, init) =>
      fetchHopWithRedirectObserver(
        url,
        init,
        browser.runtime.id,
        fetchImpl,
        browser.webRequest as unknown as RedirectObserver,
      ),
  };
}

let refreshQueue: Promise<void> = Promise.resolve();

async function runRefresh(
  settings: Settings,
  subscriptionId: string,
  dependencies: SubscriptionRefreshDependencies,
): Promise<LocalSubscriptionRefreshReceipt> {
  let uploadStarted = false;
  let result: LocalSubscriptionRefreshReceipt | null = null;
  let failed = false;
  let failure: unknown;

  try {
    let spec: SubscriptionLocalFetchSpec;
    let content: string;
    try {
      await cleanupUserAgentRule(dependencies.updateSessionRules);
      spec = await dependencies.getSpec(settings, subscriptionId);
      if (spec.subscriptionId !== subscriptionId)
        throw new Error("spec-id-mismatch");
      content = await fetchThroughLocalNetwork(spec, dependencies);
    } catch {
      throw new SubscriptionRefreshPhaseError("definite-pre-upload");
    }

    uploadStarted = true;
    try {
      const receipt = await dependencies.upload(settings, spec, content);
      if (
        !Number.isInteger(receipt.proxyCount) ||
        receipt.proxyCount < 1 ||
        !Number.isInteger(receipt.updatedAt) ||
        receipt.updatedAt < 0
      ) {
        throw new Error("invalid-receipt");
      }
      result = { proxyCount: receipt.proxyCount, updatedAt: receipt.updatedAt };
    } catch (error) {
      if (error instanceof BackendError && error.status === 412) throw error;
      throw new SubscriptionRefreshPhaseError("ambiguous-or-post-upload");
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    await cleanupUserAgentRule(dependencies.updateSessionRules);
  } catch {
    if (!failed) {
      failed = true;
      failure = new SubscriptionRefreshPhaseError(
        uploadStarted ? "ambiguous-or-post-upload" : "definite-pre-upload",
      );
    }
  }

  if (failed) throw failure;
  if (result === null)
    throw new SubscriptionRefreshPhaseError("ambiguous-or-post-upload");
  return result;
}

export function refreshSubscriptionLocally(
  settings: Settings,
  subscriptionId: string,
  dependencies?: SubscriptionRefreshDependencies,
): Promise<LocalSubscriptionRefreshReceipt> {
  const selected = dependencies ?? defaultDependencies();
  const result = refreshQueue.then(() =>
    runRefresh(settings, subscriptionId, selected),
  );
  refreshQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function cleanupSubscriptionRefreshRules(): Promise<void> {
  await cleanupUserAgentRule(defaultDependencies().updateSessionRules);
}

type LifecycleListenerRegistrar = (listener: () => void) => void;

/** Register startup/install cleanup without exposing browser globals to tests. */
export function registerSubscriptionRefreshLifecycleCleanup(
  registerStartup: LifecycleListenerRegistrar,
  registerInstalled: LifecycleListenerRegistrar,
  clearTransientState: () => void,
  cleanup: () => Promise<void> = cleanupSubscriptionRefreshRules,
): void {
  const listener = () => {
    clearTransientState();
    void cleanup().catch(() => undefined);
  };
  registerStartup(listener);
  registerInstalled(listener);
}
