import type { Request } from "@/lib/messages";
import {
  BridgeSafeError,
  LocalRefreshActivationGate,
  SUBSCRIPTION_BRIDGE_CHANNEL,
  isPageBridgeRequest,
  projectBridgeResult,
  sendBridgeBackgroundRequest,
  shouldSilenceBridgeReply,
  type ExtensionSubscriptionBridgeResponse,
} from "@/lib/subscription-bridge";

async function sendBackground(request: Request): Promise<unknown> {
  return sendBridgeBackgroundRequest(request, (message) =>
    browser.runtime.sendMessage(message),
  );
}

function activatedSubscriptionId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest("button[data-pm-local-refresh-id]");
  if (!(button instanceof HTMLButtonElement)) return null;
  const id = button.dataset.pmLocalRefreshId;
  return id &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
    ? id
    : null;
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    const activation = new LocalRefreshActivationGate();

    document.addEventListener(
      "click",
      (event) => {
        const subscriptionId = activatedSubscriptionId(event.target);
        if (subscriptionId) activation.arm(subscriptionId, event.isTrusted);
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const subscriptionId = activatedSubscriptionId(event.target);
        if (subscriptionId) activation.arm(subscriptionId, event.isTrusted);
      },
      true,
    );

    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        !isPageBridgeRequest(event.data)
      ) {
        return;
      }
      const message = event.data;
      void (async () => {
        try {
          let projected:
            | { ready: boolean }
            | { proxyCount: number; updatedAt: number };
          if (message.type === "probe") {
            const result = await sendBackground({
              type: "subscriptionBridgeStatus",
              pageOrigin: window.location.origin,
            });
            projected = projectBridgeResult("probe", result);
          } else {
            if (!activation.consume(message.subscriptionId)) {
              throw new BridgeSafeError("activation-required");
            }
            const issued = (await sendBackground({
              type: "issueSubscriptionRefreshActivation",
              pageOrigin: window.location.origin,
              subscriptionId: message.subscriptionId,
            })) as { activation?: unknown } | null;
            if (typeof issued?.activation !== "string") {
              throw new BridgeSafeError("outcome-ambiguous");
            }
            const result = await sendBackground({
              type: "refreshSubscriptionLocally",
              pageOrigin: window.location.origin,
              subscriptionId: message.subscriptionId,
              activation: issued.activation,
            });
            projected = projectBridgeResult("refresh", result) as {
              proxyCount: number;
              updatedAt: number;
            };
          }
          const reply: ExtensionSubscriptionBridgeResponse = {
            channel: SUBSCRIPTION_BRIDGE_CHANNEL,
            source: "proxymanager-extension",
            requestId: message.requestId,
            ok: true,
            data: projected,
          };
          window.postMessage(reply, window.location.origin);
        } catch (error) {
          if (shouldSilenceBridgeReply(error)) return;
          const reply: ExtensionSubscriptionBridgeResponse = {
            channel: SUBSCRIPTION_BRIDGE_CHANNEL,
            source: "proxymanager-extension",
            requestId: message.requestId,
            ok: false,
            error:
              error instanceof BridgeSafeError
                ? error.code
                : "outcome-ambiguous",
          };
          window.postMessage(reply, window.location.origin);
        }
      })();
    });
  },
});
