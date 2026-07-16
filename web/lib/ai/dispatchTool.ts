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
import { ZodError } from 'zod';
import { ConfigPreflightUnavailableError, ConfigValidationError } from '@/lib/config/errors';
import { ClientSafeProblemDetailsError, ProblemDetailsError } from '@/lib/http/problem';
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
        profileId: ctx.profileId,
      });
      const data = { action: action.name, summary: action.summary(parsed), diff, token, expiresAt };
      return { kind: 'confirm-write', data, modelContent: WRITE_PENDING_MODEL_CONTENT };
    }

    const envelope = await action.run(ctx, parsed);
    const modelContent = envelope.untrusted
      ? wrapUntrusted(envelope.data)
      : JSON.stringify(envelope.data);
    return {
      kind: envelope.kind,
      data: envelope.data,
      untrusted: envelope.untrusted,
      modelContent,
    };
  } catch (err) {
    const data = safeToolError(err, name);
    return { kind: 'error', data, modelContent: JSON.stringify(data) };
  }
}

/** Keep tool/model errors useful without reflecting unknown exception text. */
export function safeToolError(
  error: unknown,
  actionName: string,
): {
  error: string;
  errors?: unknown[];
} {
  if (error instanceof ConfigValidationError) {
    return { error: error.issue.message, errors: [error.issue] };
  }
  if (error instanceof ConfigPreflightUnavailableError) {
    return { error: error.message };
  }
  if (error instanceof ZodError) {
    return { error: '工具参数校验失败，请检查字段格式。' };
  }
  if (error instanceof ClientSafeProblemDetailsError) {
    return { error: error.problem.detail ?? error.problem.title };
  }
  if (error instanceof ProblemDetailsError) {
    const safeByStatus: Record<number, string> = {
      400: '工具请求不符合要求。',
      401: '工具请求未通过身份验证。',
      403: '工具请求没有执行权限。',
      404: '工具所需的资源不存在。',
      409: '工具操作与当前配置状态冲突，请刷新后重试。',
      412: '配置已发生变化，请刷新后重试。',
      422: '当前配置不满足该操作的执行条件。',
      429: '工具请求过于频繁，请稍后重试。',
    };
    return { error: safeByStatus[error.problem.status] ?? '工具执行遇到内部错误，请稍后重试。' };
  }

  // Unknown errors can contain complete upstream URLs, YAML anchor names or
  // credentials. Log only fixed metadata; the raw message must not reach logs,
  // the model, the browser response or an MCP client.
  const errorType = error instanceof Error ? error.name : typeof error;
  console.error('[assistant/tool] unexpected action failure', {
    action: actionName,
    errorType,
  });
  return { error: '工具执行遇到内部错误，请稍后重试。' };
}
