import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { AuditEvent, AuditTarget } from '@/schemas';

const MAX_EVENTS = 1000;

interface RecordInput {
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
}

export function generateEventId(): string {
  return crypto.randomUUID();
}

function nowMs(): number {
  return Date.now();
}

/**
 * Append a new event to the audit log. ZADD (score=ts) + HSET (payload by id)
 * in a single pipeline so the index and the payload stay in sync. Opportunistic
 * trim drops events past MAX_EVENTS — we read the trimmed ids first so we can
 * HDEL their payloads in the same trip.
 */
export async function recordEvent(input: RecordInput): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: generateEventId(),
    ts: nowMs(),
    op: input.op,
    actor: input.actor,
    ruleId: input.ruleId ?? (input.target?.kind === 'rule' ? input.target.id : undefined),
    target: input.target,
    before: input.before,
    after: input.after,
    undoes: input.undoes,
  };

  const redis = getRedis();
  const tx = redis.multi();
  tx.zadd(REDIS_KEYS.audit.events, { score: event.ts, member: event.id });
  tx.hset(REDIS_KEYS.audit.byId, { [event.id]: event });
  await tx.exec();

  // Opportunistic trim. Reading the to-evict ids requires its own RTT; we
  // only pay it when the log has actually grown past the cap.
  const card = await redis.zcard(REDIS_KEYS.audit.events);
  if (card > MAX_EVENTS) {
    const overflow = card - MAX_EVENTS;
    const evictIds = (await redis.zrange<string[]>(
      REDIS_KEYS.audit.events,
      0,
      overflow - 1,
    )) ?? [];
    if (evictIds.length > 0) {
      const trim = redis.multi();
      trim.zremrangebyrank(REDIS_KEYS.audit.events, 0, overflow - 1);
      trim.hdel(REDIS_KEYS.audit.byId, ...evictIds);
      await trim.exec();
    }
  }

  return event;
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
}

export async function listEvents(opts: ListEventsOptions = {}): Promise<AuditEvent[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const redis = getRedis();
  // Upstash's zrange types accept `+inf` / `-inf` / `(N` template-literal
  // strings — cast to satisfy the union without losing exclusive-bound
  // semantics for pagination.
  const max = (
    opts.beforeTs !== undefined ? (`(${opts.beforeTs}` as const) : '+inf'
  ) as `(${number}` | '+inf';
  // Newest first.
  const ids = (await redis.zrange<string[]>(REDIS_KEYS.audit.events, max, '-inf', {
    byScore: true,
    rev: true,
    count: limit,
    offset: 0,
  })) ?? [];
  if (ids.length === 0) return [];

  const payloads = await redis.hmget<Record<string, AuditEvent>>(
    REDIS_KEYS.audit.byId,
    ...ids,
  );
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
