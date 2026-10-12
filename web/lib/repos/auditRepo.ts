import { mutationPlanning } from './mutationContext';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { AuditEvent, AuditTarget } from '@/schemas';

const MAX_EVENTS = 1000;

export interface RecordInput {
  op: AuditEvent['op'];
  actor: string;
  /**
   * Either provide a target (preferred for scenario ops) or a legacy ruleId
   * (kept for backward compat with rule.* events). Both may be set when a
   * scenario op happens to act on a rule.
   */
  target?: AuditTarget;
  ruleId?: string;
  before?: unknown;
  after?: unknown;
  undoes?: string;
  /** Explicit capability marker for operations without a safe inverse. */
  undoable?: boolean;
  /** Profile the mutation targeted (Phase 2 per-profile config). */
  profileId?: string;
}

export function generateEventId(): string {
  return crypto.randomUUID();
}

function nowMs(): number {
  return Date.now();
}

export function buildEvents(inputs: RecordInput[]): AuditEvent[] {
  const baseTs = nowMs();
  return inputs.map((input, index) => ({
    ...input,
    id: generateEventId(),
    // Preserve input order within a batch rather than sorting UUID ties randomly.
    ts: baseTs + index,
    ruleId: input.ruleId ?? (input.target?.kind === 'rule' ? input.target.id : undefined),
  }));
}

export const TRIM_EVENTS = `
local overflow = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[1])
if overflow <= 0 then return 0 end
local ids = redis.call('ZRANGE', KEYS[1], 0, overflow - 1)
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
end
return #ids
`;

export async function trimEvents(): Promise<void> {
  await getRedis().eval(
    TRIM_EVENTS,
    [REDIS_KEYS.audit.events, REDIS_KEYS.audit.byId],
    [MAX_EVENTS],
  );
}

export async function recordEvent(input: RecordInput): Promise<AuditEvent> {
  return (await recordEvents([input]))[0];
}

export async function recordEvents(inputs: RecordInput[]): Promise<AuditEvent[]> {
  if (!inputs.length) return [];
  const events = buildEvents(inputs);
  const plan = mutationPlanning.getStore();
  if (plan) {
    plan.events.push(...events);
    return events;
  }
  await persistBuiltEvents(events);
  return events;
}

/** Persist existing IDs and snapshots without rebuilding events collected during planning. */
export async function persistBuiltEvents(events: AuditEvent[]): Promise<void> {
  if (!events.length) return;
  const tx = getRedis().multi();
  for (const event of events)
    tx.zadd(REDIS_KEYS.audit.events, { score: event.ts, member: event.id });
  tx.hset(REDIS_KEYS.audit.byId, Object.fromEntries(events.map((event) => [event.id, event])));
  await tx.exec();
  await trimEvents().catch(() => undefined);
}

/**
 * Mark an event as having been undone, persisting the link to the undo event.
 * No-op if the event no longer exists (e.g. trimmed). Returns whether it was
 * updated.
 */
export async function markUndone(eventId: string, undoneByEventId: string): Promise<boolean> {
  const redis = getRedis();
  const existing = await redis.hget<AuditEvent>(REDIS_KEYS.audit.byId, eventId);
  if (!existing) return false;
  const updated: AuditEvent = { ...existing, undone_by: undoneByEventId };
  await redis.hset(REDIS_KEYS.audit.byId, { [eventId]: updated });
  return true;
}

export interface ListEventsOptions {
  limit?: number;
  /** Return events strictly older than this ms timestamp (for pagination). */
  beforeTs?: number;
  cursor?: string;
}

export async function listEvents(opts: ListEventsOptions = {}): Promise<AuditEvent[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const redis = getRedis();
  // Upstash's zrange types accept `+inf` / `-inf` / `(N` template-literal
  // strings — cast to satisfy the union without losing exclusive-bound
  // semantics for pagination.
  let boundary: [number, string] | undefined;
  if (opts.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString());
      if (
        !Array.isArray(decoded) ||
        !Number.isSafeInteger(decoded[0]) ||
        typeof decoded[1] !== 'string'
      )
        throw new Error();
      boundary = [decoded[0], decoded[1]];
    } catch {
      throw ProblemDetailsError.badRequest('Invalid history cursor');
    }
  }
  // Retention bounds the index to 1000 entries. A (score, member) cursor keeps
  // every same-millisecond event, even if the boundary event was trimmed.
  const max = boundary
    ? boundary[0]
    : opts.beforeTs !== undefined
      ? (`(${opts.beforeTs}` as const)
      : '+inf';
  const raw = await redis.zrange<string[]>(REDIS_KEYS.audit.events, max, '-inf', {
    byScore: true,
    rev: true,
    withScores: true,
    count: boundary ? MAX_EVENTS : limit,
    offset: 0,
  });
  const ids: string[] = [];
  for (let i = 0; i < (raw?.length ?? 0); i += 2) {
    const id = String(raw[i]);
    const score = Number(raw[i + 1]);
    if (boundary && score === boundary[0] && id >= boundary[1]) continue;
    ids.push(id);
    if (ids.length === limit) break;
  }
  if (ids.length === 0) return [];

  const payloads = await redis.hmget<Record<string, AuditEvent>>(REDIS_KEYS.audit.byId, ...ids);
  if (!payloads) return [];

  const out: AuditEvent[] = [];
  for (const id of ids) {
    const ev = payloads[id];
    if (ev) out.push(ev);
  }
  return out;
}

export async function getEvent(id: string): Promise<AuditEvent | null> {
  const ev = await getRedis().hget<AuditEvent>(REDIS_KEYS.audit.byId, id);
  return ev ?? null;
}

export function eventCursor(event: AuditEvent): string {
  return Buffer.from(JSON.stringify([event.ts, event.id])).toString('base64url');
}
