/**
 * Pure, client-safe types + helpers shared by the server tool dispatcher
 * (`dispatchTool.ts`) and the browser-side agent loop. Kept free of any
 * server-only import so the browser bundle can use `ToolDispatchResult` and
 * `wrapUntrusted` without pulling in the action registry / Redis.
 */

export interface ToolDispatchResult {
  /** Component id the UI renders (e.g. 'proxy-group-members', 'confirm-write', 'error'). */
  kind: string;
  /** Payload for that component. */
  data: unknown;
  /** When true, `data` is untrusted external text (already reflected in modelContent). */
  untrusted?: boolean;
  /** Exact string to feed back to the model as this tool call's result. */
  modelContent: string;
}

/** Spotlight untrusted external data so the model treats it as reference, not instructions. */
export function wrapUntrusted(data: unknown): string {
  return `<external_data trust="untrusted">\n${JSON.stringify(data)}\n</external_data>`;
}

/** Neutral tool result after a write is staged: the model must not claim success. */
export const WRITE_PENDING_MODEL_CONTENT =
  '已向用户出示写操作确认卡，正在等待用户授权。在用户确认前不要重复发起该操作，也不要声称已经完成；可简要说明这条改动会做什么。';
