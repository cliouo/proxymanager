'use client';

import {
  agentTools,
  createAgent,
  registerTools,
  type AgentAction,
  type AgentStep,
} from '@ui-sdk/react/agent';
import { pulseRequestSource, withRequestSource } from '@/ui/data/api';
import { requestAgentConfirm } from './confirm';
import { customTools, executeCustomTool } from './custom-tools';
import {
  beginWebMcpPulse,
  emitElementActionFx,
  isBuiltinOwnerValid,
  isWorkspaceBusyForWebMcp,
  resolveActionTargetElement,
  waitIfPaused,
} from './takeover';

interface WebMcpToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

interface WebMcpModelContext {
  registerTool?: (tool: WebMcpToolRegistration, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
}

export type AppAgent = ReturnType<typeof createAgent>;

interface ActiveCallContext {
  source: 'ai_chat' | 'webmcp';
  owner?: AbortController;
  signal?: AbortSignal;
  onNavigationIntent?: (expectedPath?: string) => void;
}

const NON_NAV_COMMANDS = new Set([
  'copy-subscription-link',
  'share-qr',
  'ai-assistant',
  'toggle-theme',
]);

const STATIC_NAV_COMMAND_PATHS: Record<string, string> = {
  'nav-sources': '/sources',
  'nav-rule-sets': '/rule-sets',
  'nav-profiles': '/profiles',
  'nav-history': '/history',
  'nav-settings': '/settings',
  'add-source': '/sources',
};

function detectNavigationIntent(
  step: AgentAction,
  target: HTMLElement | null,
): { expected: boolean; expectedPath?: string } {
  if (typeof window === 'undefined') return { expected: false };
  const currentPath = window.location.pathname;

  if (step.component === 'command' && step.action === 'run') {
    const value = typeof step.args[0] === 'string' ? step.args[0].trim() : '';
    if (!value || NON_NAV_COMMANDS.has(value)) return { expected: false };
    const activeValue = target?.closest<HTMLElement>('[data-agent-active-value]')?.getAttribute('data-agent-active-value');
    if (activeValue && activeValue === value) return { expected: false };
    const staticPath = STATIC_NAV_COMMAND_PATHS[value];
    if (staticPath) {
      return staticPath === currentPath ? { expected: false } : { expected: true, expectedPath: staticPath };
    }
    return { expected: true };
  }

  if (step.action !== 'press' && step.action !== 'click') return { expected: false };
  if (!target) return { expected: false };

  if (step.component === 'menu' && typeof step.args[0] === 'string') {
    const navItemsAttr = target.closest<HTMLElement>('[data-agent-nav-items]')?.getAttribute('data-agent-nav-items');
    if (navItemsAttr) {
      try {
        const navMap = JSON.parse(navItemsAttr) as Record<string, string>;
        const raw = navMap[step.args[0].trim()];
        if (raw) {
          const resolved = new URL(raw, window.location.href);
          if (resolved.origin === window.location.origin && resolved.pathname !== currentPath) {
            return { expected: true, expectedPath: resolved.pathname };
          }
          return { expected: false };
        }
      } catch {
        /* ignore malformed nav items map */
      }
    }
  }

  const navHost = target.closest<HTMLElement>('[data-agent-nav]');
  if (navHost) {
    const raw = navHost.getAttribute('data-agent-nav')?.trim();
    if (!raw) return { expected: true };
    try {
      const resolved = new URL(raw, window.location.href);
      if (resolved.origin === window.location.origin && resolved.pathname !== currentPath) {
        return { expected: true, expectedPath: resolved.pathname };
      }
      return { expected: false };
    } catch {
      return { expected: true };
    }
  }

  const anchor = target.closest<HTMLAnchorElement>('a[href]');
  if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) {
    return { expected: false };
  }
  try {
    const resolved = new URL(anchor.href, window.location.href);
    if (resolved.origin !== window.location.origin || resolved.pathname === currentPath) {
      return { expected: false };
    }
    return { expected: true, expectedPath: resolved.pathname };
  } catch {
    return { expected: false };
  }
}

let activeCallContext: ActiveCallContext | null = null;
let lastFxKey = '';
let lastFxAt = 0;

function emitStepFxOnce(step: AgentAction, target: HTMLElement | null) {
  const key = `${step.ref}:${step.action}`;
  const now = Date.now();
  if (key === lastFxKey && now - lastFxAt < 180) return;
  lastFxKey = key;
  lastFxAt = now;
  const kind =
    step.action === 'press' || step.action === 'click' || step.action === 'toggle' || step.action === 'setChecked'
      ? 'press'
      : 'fill';
  emitElementActionFx(target, kind);
}

export function createAppAllow() {
  return async (step: AgentAction, { signal }: { signal: AbortSignal }): Promise<boolean> => {
    const ctx = activeCallContext;
    const isBuiltin = ctx?.source === 'ai_chat';

    if (!isBuiltin && isWorkspaceBusyForWebMcp()) {
      return false;
    }

    if (isBuiltin) {
      if (signal.aborted || ctx.signal?.aborted || !isBuiltinOwnerValid(ctx.owner)) {
        return false;
      }
      try {
        await waitIfPaused(ctx.signal ?? signal, ctx.owner);
      } catch {
        return false;
      }
      if (signal.aborted || ctx.signal?.aborted || !isBuiltinOwnerValid(ctx.owner)) {
        return false;
      }
    }

    if (step.confirm) {
      const approved = await requestAgentConfirm(step, { signal });
      if (!approved) return false;
      if (isBuiltin && (signal.aborted || ctx.signal?.aborted || !isBuiltinOwnerValid(ctx.owner))) {
        return false;
      }
      if (!isBuiltin && isWorkspaceBusyForWebMcp()) {
        return false;
      }
    }

    if (!isBuiltin && !ctx) {
      const endPulse = beginWebMcpPulse();
      setTimeout(endPulse, 900);
    }

    const target = resolveActionTargetElement(step);
    const nav = detectNavigationIntent(step, target);
    if (nav.expected) {
      ctx?.onNavigationIntent?.(nav.expectedPath);
    }

    emitStepFxOnce(step, target);
    return true;
  };
}

let singleton: AppAgent | null = null;

export function getAgent(): AppAgent {
  if (typeof window === 'undefined') {
    throw new Error('Agent bridge is only available in the browser');
  }
  if (!singleton) {
    singleton = createAgent({ allow: createAppAllow() });
  }
  return singleton;
}

function captureAssistantFocus(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('[data-assistant-panel]')) {
    return active;
  }
  return null;
}

function restoreAssistantFocusIfStolen(prev: HTMLElement | null) {
  if (!prev || !prev.isConnected || typeof document === 'undefined') return;
  const active = document.activeElement;
  // Respect intentional focus moves into assistant, pause bar, or confirm card.
  if (
    active instanceof HTMLElement &&
    active.closest('[data-assistant-panel], [data-takeover-bar], [data-agent-confirm-card]')
  ) {
    return;
  }
  prev.focus({ preventScroll: true });
}

export async function runAgentAct(
  input: { steps: AgentStep[] },
  options?: {
    signal?: AbortSignal;
    source?: 'ai_chat' | 'webmcp';
    owner?: AbortController;
    agent?: AppAgent;
    onNavigationIntent?: (expectedPath?: string) => void;
  },
) {
  const target = options?.agent ?? getAgent();
  const source = options?.source ?? 'ai_chat';
  const prevFocus = source === 'ai_chat' ? captureAssistantFocus() : null;
  const prevCtx = activeCallContext;
  activeCallContext = {
    source,
    owner: options?.owner,
    signal: options?.signal,
    onNavigationIntent: options?.onNavigationIntent,
  };
  try {
    return await withRequestSource(source, () =>
      target.act(input, options?.signal ? { signal: options.signal } : undefined),
    );
  } finally {
    activeCallContext = prevCtx;
    restoreAssistantFocusIfStolen(prevFocus);
  }
}

export async function runAgentQuery(
  input: Parameters<AppAgent['query']>[0],
  options?: { signal?: AbortSignal; source?: 'ai_chat' | 'webmcp'; owner?: AbortController; agent?: AppAgent },
) {
  const target = options?.agent ?? getAgent();
  const source = options?.source ?? 'ai_chat';
  const prevFocus = source === 'ai_chat' ? captureAssistantFocus() : null;
  const prevCtx = activeCallContext;
  activeCallContext = { source, owner: options?.owner, signal: options?.signal };
  try {
    return await withRequestSource(source, () => target.query(input));
  } finally {
    activeCallContext = prevCtx;
    restoreAssistantFocusIfStolen(prevFocus);
  }
}

export function registerAppWebMcp(target: AppAgent = getAgent()): () => void {
  let cancelPulse: (() => void) | null = null;
  const unregisterBridge = registerTools(target, {
    allow: () => {
      if (isWorkspaceBusyForWebMcp()) return false;
      // Bridge allow already asks the user for data-agent-confirm steps; avoid double prompts.
      cancelPulse = pulseRequestSource('webmcp');
      return true;
    },
  });

  const modelContext =
    typeof document !== 'undefined'
      ? (document as Document & { modelContext?: WebMcpModelContext }).modelContext
      : undefined;
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  if (modelContext?.registerTool) {
    for (const tool of customTools) {
      let registration: unknown;
      try {
        registration = modelContext.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            execute: (input) => executeCustomTool(tool.name, input, { source: 'webmcp', agent: target }),
          },
          { signal: controller.signal },
        );
      } catch {
        continue;
      }
      if (registration && typeof (registration as PromiseLike<unknown>).then === 'function') {
        // Chrome's native WebMCP registerTool rejects with AbortError when signal aborts on unmount/HMR.
        Promise.resolve(registration).catch(() => undefined);
      }
      if (typeof registration === 'function') {
        cleanups.push(registration as () => void);
      } else if (typeof modelContext.unregisterTool === 'function') {
        const unregisterTool = modelContext.unregisterTool.bind(modelContext);
        cleanups.push(() => {
          try {
            Promise.resolve(unregisterTool(tool.name)).catch(() => undefined);
          } catch {
            /* ignore unregister failure on unmount */
          }
        });
      }
    }
  }

  return () => {
    cancelPulse?.();
    cancelPulse = null;
    controller.abort();
    for (const cleanup of cleanups) cleanup();
    unregisterBridge();
  };
}

export { agentTools };
export type { AgentAction, AgentComponent, AgentStep, ObservedChange } from '@ui-sdk/react/agent';
