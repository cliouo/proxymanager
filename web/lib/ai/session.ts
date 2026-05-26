/**
 * Server-side assistant conversation store. Holds the FULL message thread per
 * conversation (user / assistant-with-tool_calls / tool results, including
 * reasoning_content), so a follow-up turn keeps the config and docs the model
 * already pulled instead of re-fetching — and so thinking-mode reasoning_content
 * (which only exists at generation time) is preserved across turns.
 *
 * The system prompt is NOT stored; it's prepended fresh each run so prompt
 * changes take effect immediately. Standalone Redis key with a TTL; oldest
 * whole rounds are dropped once the transcript exceeds a char budget (never
 * splitting a tool_call <-> tool pair, which would break the API).
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { ChatMessage } from './deepseek';

const TTL_SECONDS = 60 * 60 * 2; // 2h idle expiry
const MAX_CHARS = 60_000; // ~ transcript budget before compaction
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidConversationId(id: string): boolean {
  return ID_RE.test(id);
}

export async function loadSession(id: string): Promise<ChatMessage[]> {
  if (!isValidConversationId(id)) return [];
  const raw = await getRedis().get<ChatMessage[]>(REDIS_KEYS.assistantSession(id));
  return Array.isArray(raw) ? raw : [];
}

export async function saveSession(id: string, messages: ChatMessage[]): Promise<void> {
  if (!isValidConversationId(id)) return;
  const compacted = compactHistory(messages);
  await getRedis().set(REDIS_KEYS.assistantSession(id), compacted, { ex: TTL_SECONDS });
}

function msgChars(m: ChatMessage): number {
  return (
    (m.content?.length ?? 0) +
    (m.reasoning_content?.length ?? 0) +
    (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)
  );
}

/**
 * Drop oldest whole rounds (a round = a user message and everything up to the
 * next user message) until under budget, always keeping at least the last
 * round. Keeping rounds intact preserves every tool_call/tool pairing.
 */
export function compactHistory(messages: ChatMessage[], maxChars = MAX_CHARS): ChatMessage[] {
  let total = messages.reduce((s, m) => s + msgChars(m), 0);
  if (total <= maxChars) return messages;

  const userIdx = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  let start = 0;
  for (let r = 0; r < userIdx.length - 1 && total > maxChars; r++) {
    for (let i = userIdx[r]; i < userIdx[r + 1]; i++) total -= msgChars(messages[i]);
    start = userIdx[r + 1];
  }
  return messages.slice(start);
}
