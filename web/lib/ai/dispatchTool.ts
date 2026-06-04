/**
 * Single tool-call dispatch — the per-call body extracted from the orchestrator
 * loop so both the (legacy) server loop and the new `POST /api/v1/assistant/tool`
 * endpoint share one implementation. Reads run inline; writes never execute —
 * they preview + mint a confirmation token, exactly as before. The browser-side
 * orchestrator drives this endpoint once per tool call the model requests.
 */

import { getAction } from './actions/registry';
import { assertWriteAllowed } from './actions/neverList';
import { mintConfirmation } from './confirm';
import type { ActionContext } from './actions/types';
import {
  WRITE_PENDING_MODEL_CONTENT,
  wrapUntrusted,
  type ToolDispatchResult,
} from './toolDispatchTypes';

export async function dispatchToolCall(
  ctx: ActionContext,
  name: string,
  rawInput: unknown,
): Promise<ToolDispatchResult> {
  const action = getAction(name);
  if (!action) {
    const data = { error: `未知工具 "${name}"` };
    return { kind: 'error', data, modelContent: JSON.stringify(data) };
  }

  try {
    const parsed = action.input.parse(rawInput ?? {});

    if (action.risk === 'write') {
      // Writes never execute inline: validate + preview, mint a one-time token,
      // hand the user a confirm card. The mutation runs later via /confirm.
      assertWriteAllowed(action);
      const { diff } = await action.preview(ctx, parsed);
      const { token, expiresAt } = await mintConfirmation({
        actor: ctx.actor,
        action: action.name,
        input: parsed,
      });
      const data = { action: action.name, summary: action.summary(parsed), diff, token, expiresAt };
      return { kind: 'confirm-write', data, modelContent: WRITE_PENDING_MODEL_CONTENT };
    }

    const envelope = await action.run(ctx, parsed);
    const modelContent = envelope.untrusted
      ? wrapUntrusted(envelope.data)
      : JSON.stringify(envelope.data);
    return { kind: envelope.kind, data: envelope.data, untrusted: envelope.untrusted, modelContent };
  } catch (err) {
    const data = { error: err instanceof Error ? err.message : String(err) };
    return { kind: 'error', data, modelContent: JSON.stringify(data) };
  }
}
