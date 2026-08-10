import type { Request } from "./messages";
import type { Settings } from "./settings";

export const SUBSCRIPTION_BRIDGE_CHANNEL =
  "proxymanager-subscription-bridge-v1" as const;
export const ACTIVATION_TTL_MS = 10_000;

export type PageSubscriptionBridgeRequest =
  | {
      channel: typeof SUBSCRIPTION_BRIDGE_CHANNEL;
      source: "proxymanager-web";
      requestId: string;
      type: "probe";
    }
  | {
      channel: typeof SUBSCRIPTION_BRIDGE_CHANNEL;
      source: "proxymanager-web";
      requestId: string;
      type: "refresh";
      subscriptionId: string;
    };

export type BridgeSafeErrorCode =
  | "activation-required"
  | "extension-not-configured"
  | "origin-mismatch"
  | "invalid-request"
  | "fetch-failed"
  | "upload-failed"
  | "concurrent-update"
  | "outcome-ambiguous";

const BRIDGE_SAFE_ERROR_CODES: Readonly<Record<BridgeSafeErrorCode, true>> = {
  "activation-required": true,
  "extension-not-configured": true,
  "origin-mismatch": true,
  "invalid-request": true,
  "fetch-failed": true,
  "upload-failed": true,
  "concurrent-update": true,
  "outcome-ambiguous": true,
};

export function isBridgeSafeErrorCode(
  value: unknown,
): value is BridgeSafeErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(BRIDGE_SAFE_ERROR_CODES, value)
  );
}

export class BridgeSafeError extends Error {
  constructor(public readonly code: BridgeSafeErrorCode) {
    super(code);
    this.name = "BridgeSafeError";
  }
}

/** Origin mismatches are intentionally invisible to the untrusted page. */
export function shouldSilenceBridgeReply(error: unknown): boolean {
  return error instanceof BridgeSafeError && error.code === "origin-mismatch";
}

export type ExtensionSubscriptionBridgeResponse =
  | {
      channel: typeof SUBSCRIPTION_BRIDGE_CHANNEL;
      source: "proxymanager-extension";
      requestId: string;
      ok: true;
      data: { ready: boolean } | { proxyCount: number; updatedAt: number };
    }
  | {
      channel: typeof SUBSCRIPTION_BRIDGE_CHANNEL;
      source: "proxymanager-extension";
      requestId: string;
      ok: false;
      error: BridgeSafeErrorCode;
    };

export async function sendBridgeBackgroundRequest(
  request: Request,
  sendMessage: (request: Request) => Promise<unknown>,
): Promise<unknown> {
  let response: unknown;
  try {
    response = await sendMessage(request);
  } catch {
    throw new BridgeSafeError("outcome-ambiguous");
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new BridgeSafeError("outcome-ambiguous");
  }
  const envelope = response as {
    ok?: unknown;
    data?: unknown;
    error?: unknown;
  };
  if (envelope.ok === false) {
    throw new BridgeSafeError(
      isBridgeSafeErrorCode(envelope.error)
        ? envelope.error
        : "outcome-ambiguous",
    );
  }
  if (
    envelope.ok !== true ||
    !Object.prototype.hasOwnProperty.call(envelope, "data")
  ) {
    throw new BridgeSafeError("outcome-ambiguous");
  }
  return envelope.data;
}
export interface BridgeSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number };
}

export function assertBridgeSenderOrigin(
  settings: Settings,
  claimedOrigin: string,
  sender: BridgeSender,
  extensionId: string,
): void {
  let backendOrigin: string;
  let senderUrlOrigin: string;
  try {
    backendOrigin = new URL(settings.backendUrl).origin;
    senderUrlOrigin = new URL(sender.url ?? "").origin;
  } catch {
    throw new BridgeSafeError("origin-mismatch");
  }
  if (
    sender.id !== extensionId ||
    !Number.isInteger(sender.tab?.id) ||
    typeof sender.origin !== "string" ||
    sender.origin !== claimedOrigin ||
    senderUrlOrigin !== claimedOrigin ||
    backendOrigin !== claimedOrigin
  ) {
    throw new BridgeSafeError("origin-mismatch");
  }
}

/** Capture-phase, trusted, id-scoped, one-shot page activation. */
export class LocalRefreshActivationGate {
  private armed: { subscriptionId: string; expiresAt: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  arm(subscriptionId: string, trusted: boolean): void {
    this.armed = trusted
      ? { subscriptionId, expiresAt: this.now() + ACTIVATION_TTL_MS }
      : null;
  }

  consume(subscriptionId: string): boolean {
    const armed = this.armed;
    this.armed = null;
    return Boolean(
      armed &&
      armed.subscriptionId === subscriptionId &&
      this.now() <= armed.expiresAt,
    );
  }
}

export function projectBridgeResult(
  type: "probe" | "refresh",
  value: unknown,
): { ready: boolean } | { proxyCount: number; updatedAt: number } {
  const candidate = value as Record<string, unknown> | null;
  if (type === "probe") {
    if (typeof candidate?.ready !== "boolean") {
      throw new BridgeSafeError("outcome-ambiguous");
    }
    return { ready: candidate.ready };
  }
  const proxyCount = candidate?.proxyCount;
  const updatedAt = candidate?.updatedAt;
  if (
    !Number.isInteger(proxyCount) ||
    Number(proxyCount) < 1 ||
    !Number.isInteger(updatedAt) ||
    Number(updatedAt) < 0
  ) {
    throw new BridgeSafeError("outcome-ambiguous");
  }
  return { proxyCount: Number(proxyCount), updatedAt: Number(updatedAt) };
}

export function isPageBridgeRequest(
  value: unknown,
): value is PageSubscriptionBridgeRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<PageSubscriptionBridgeRequest>;
  if (
    request.channel !== SUBSCRIPTION_BRIDGE_CHANNEL ||
    request.source !== "proxymanager-web" ||
    typeof request.requestId !== "string" ||
    request.requestId.length < 1 ||
    request.requestId.length > 128
  ) {
    return false;
  }
  return (
    request.type === "probe" ||
    (request.type === "refresh" &&
      typeof request.subscriptionId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        request.subscriptionId,
      ))
  );
}
