/**
 * Assistant orchestration loop.
 *
 * Drives DeepSeek with the action registry as tools, dispatches read actions
 * as the model calls them, streams every step out as a typed event, and caps
 * the loop so it can't spin. Tier B is read-only: any write action is refused
 * here (Tier C swaps that refusal for the confirmation handshake).
 *
 * Injection isolation (spotlighting / delimit): action results flagged
 * `untrusted` (e.g. fetched docs) are wrapped in an <external_data> envelope
 * before being handed back to the model, and the system prompt declares that
 * anything inside such tags is reference material, never instructions.
 */

import { listActions } from './actions/registry';
import type { ActionContext } from './actions/types';
import { deepseekChat, type ChatMessage } from './deepseek';
import { dispatchToolCall } from './dispatchTool';
import { loadSession, saveSession } from './session';
import { SYSTEM_PROMPT } from './systemPrompt';
import { actionsToTools } from './toolSchema';

const MAX_ITERATIONS = 8;

export type AssistantEvent =
  | { type: 'tool_call'; id: string; name: string }
  | { type: 'component'; id: string; name: string; kind: string; data: unknown }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string };

export interface RunAssistantOptions {
  actor: string;
  /** Conversation id — keys the server-side transcript across turns. */
  conversationId: string;
  /** The new user turn. Prior turns are loaded from the session store. */
  userMessage: string;
  emit: (event: AssistantEvent) => void;
  signal?: AbortSignal;
}

export async function runAssistant(opts: RunAssistantOptions): Promise<void> {
  const { actor, conversationId, userMessage, emit, signal } = opts;
  const ctx: ActionContext = { actor };
  const tools = actionsToTools(listActions());

  // Full prior transcript (tool calls + results + reasoning_content) so the
  // model keeps everything it already gathered. System prompt is re-added here
  // (not persisted) so prompt changes apply immediately.
  const prior = await loadSession(conversationId);
  const convo: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...prior,
    { role: 'user', content: userMessage },
  ];

  let completed = false;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal?.aborted) return; // aborted turn: do NOT persist

    const message = await deepseekChat(convo, tools, signal);
    convo.push({
      role: 'assistant',
      content: message.content,
      // Thinking mode: reasoning from a tool-calling turn must be echoed back.
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      tool_calls: message.tool_calls,
    });

    if (!message.tool_calls?.length) {
      if (message.content) emit({ type: 'message', content: message.content });
      completed = true;
      break;
    }

    for (const call of message.tool_calls) {
      emit({ type: 'tool_call', id: call.id, name: call.function.name });
      let rawInput: unknown = {};
      try {
        rawInput = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* malformed args → dispatch will surface a validation error */
      }
      const result = await dispatchToolCall(ctx, call.function.name, rawInput);
      emit({
        type: 'component',
        id: call.id,
        name: call.function.name,
        kind: result.kind,
        data: result.data,
      });
      convo.push({ role: 'tool', tool_call_id: call.id, content: result.modelContent });
    }
  }

  if (!completed) {
    emit({
      type: 'message',
      content: '（已达到工具调用上限，先就目前掌握的信息作答；如需继续可再问。）',
    });
  }

  // Persist only on a fully-completed turn (or the capped fallback). A thrown
  // API error skips this, leaving the session at its pre-turn state so the
  // client can safely retry the same user message.
  await saveSession(conversationId, convo.slice(1));
}
