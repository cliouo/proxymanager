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

export function createAppAllow() {
  return (step: AgentAction, { signal }: { signal: AbortSignal }): boolean | Promise<boolean> =>
    step.confirm ? requestAgentConfirm(step, { signal }) : true;
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

export function runAgentAct(
  input: { steps: AgentStep[] },
  options?: { signal?: AbortSignal; source?: string; agent?: AppAgent },
) {
  const target = options?.agent ?? getAgent();
  return withRequestSource(options?.source ?? 'ai_chat', () =>
    target.act(input, options?.signal ? { signal: options.signal } : undefined),
  );
}

export function registerAppWebMcp(target: AppAgent = getAgent()): () => void {
  let cancelPulse: (() => void) | null = null;
  const unregisterBridge = registerTools(target, {
    allow: () => {
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
      const registration = modelContext.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: (input) => executeCustomTool(tool.name, input, { source: 'webmcp' }),
        },
        { signal: controller.signal },
      );
      if (typeof registration === 'function') {
        cleanups.push(registration as () => void);
      } else if (typeof modelContext.unregisterTool === 'function') {
        const unregisterTool = modelContext.unregisterTool.bind(modelContext);
        cleanups.push(() => {
          void unregisterTool(tool.name);
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
