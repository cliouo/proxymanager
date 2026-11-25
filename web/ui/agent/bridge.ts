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
  const unregister = registerTools(target, {
    allow: () => {
      // Bridge allow already asks the user for data-agent-confirm steps; avoid double prompts.
      cancelPulse = pulseRequestSource('webmcp');
      return true;
    },
  });
  return () => {
    cancelPulse?.();
    cancelPulse = null;
    unregister();
  };
}

export { agentTools };
export type { AgentAction, AgentComponent, AgentStep, ObservedChange } from '@ui-sdk/react/agent';
