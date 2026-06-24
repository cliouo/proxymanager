/**
 * Write confirmation tokens — the server side of the two-step handshake.
 *
 * When the model calls a write action the orchestrator mints a token holding
 * the {actor, action, input} to run, shows the user a confirm card, and does
 * NOT execute. The user authorises via /api/v1/assistant/confirm, which
 * consumes the token (atomic GETDEL = one-time) and runs the write.
 *
 * Tokens expire in 5 minutes and are bound to the resolved input, so the model
 * can never smuggle a different payload past the confirmation the user saw.
 */

import { randomBytes } from 'node:crypto';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

const TTL_SECONDS = 300;

export interface ConfirmationRecord {
  actor: string;
  action: string;
  /** The already-validated action input to execute. */
  input: unknown;
  /**
   * Profile the write targets, captured at preview time so executing the
   * confirmation later hits the same profile regardless of the current cookie.
   */
  profileId: string;
}

export interface MintedConfirmation {
  token: string;
  /** Epoch ms when the token expires. */
  expiresAt: number;
}

export async function mintConfirmation(record: ConfirmationRecord): Promise<MintedConfirmation> {
  const token = randomBytes(18).toString('hex');
  await getRedis().set(REDIS_KEYS.assistantConfirm(token), record, { ex: TTL_SECONDS });
  return { token, expiresAt: Date.now() + TTL_SECONDS * 1000 };
}

/** Atomically fetch + delete a confirmation. Returns null if missing/expired/used. */
export async function consumeConfirmation(token: string): Promise<ConfirmationRecord | null> {
  if (!/^[a-f0-9]{36}$/.test(token)) return null;
  const record = await getRedis().getdel<ConfirmationRecord>(REDIS_KEYS.assistantConfirm(token));
  return record ?? null;
}
