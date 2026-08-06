import { buildRawScope } from '@/lib/proxies/handleScopes';
import { NamingAuditEventSchema, type AuditEvent } from '@/schemas';
import { GLOBAL_NAMING_SCOPE_ID } from '@/lib/services/namingTargetScope';

/**
 * pass-8 blocker 7: EXTERNAL history surfaces must never carry raw
 * entity/profile UUIDs. Profile-scoped naming audits persist `target.id` +
 * `profileId`; global workspace audits persist `target.id` + scope=global.
 * Every response/API/model projection replaces the target id with the same
 * keyed ref used by its authority domain, and profile ids (when present) with
 * keyed profile handles.
 * Non-naming events pass through untouched (their target shapes are owned by
 * their own surfaces).
 *
 * round-2: NO single-mint helpers — every projection goes through ONE
 * collision-checked raw scope over the COMPLETE event domain (a history page
 * spans many profile salts, so the fully composed MAC inputs are the domain).
 */
function projectNamingAuditForExternalWithScopes(
  event: AuditEvent,
  targetScope: ReturnType<typeof buildRawScope>,
  profileScope: ReturnType<typeof buildRawScope>,
): AuditEvent {
  if (event.target?.kind !== 'naming-source') return event;
  const profileId = event.profileId;
  const global = event.scope === 'global';
  if (!global && !profileId) return event;
  const target = event.target as {
    kind: 'naming-source';
    type: 'subscription' | 'collection';
    id: string;
    name: string;
  };
  const salt = global ? GLOBAL_NAMING_SCOPE_ID : profileId!;
  const projectedTarget = {
    ...target,
    id: targetScope.project(`${salt}\x00${target.type}:${target.id}`),
  };
  if (global) {
    return { ...event, target: projectedTarget };
  }
  return {
    ...event,
    target: projectedTarget,
    profileId: profileScope.project(`${profileId}\x00profile:${profileId}`),
  };
}

/** Single-event projection (test seam + single-event callers): the complete
 * domain for one event IS the event itself — one raw scope per purpose. */
export function projectNamingAuditForExternal(event: AuditEvent): AuditEvent | null {
  const isNamingCandidate =
    event.target?.kind === 'naming-source' ||
    event.op === 'naming.apply' ||
    event.op === 'naming.rollback';
  if (!isNamingCandidate) return event;
  // Redis may contain legacy/corrupt rows that bypassed today's strict write
  // schema. A naming event without its bound profile cannot be projected to
  // an opaque target ref, so drop it instead of returning the raw target id.
  const parsed = NamingAuditEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const safeEvent = parsed.data;
  const salt = safeEvent.scope === 'global' ? GLOBAL_NAMING_SCOPE_ID : safeEvent.profileId!;
  const targetScope = buildRawScope('target-ref', [
    `${salt}\x00${safeEvent.target.type}:${safeEvent.target.id}`,
  ]);
  const profileScope = buildRawScope(
    'profile-ref',
    safeEvent.profileId ? [`${safeEvent.profileId}\x00profile:${safeEvent.profileId}`] : [],
  );
  return projectNamingAuditForExternalWithScopes(safeEvent, targetScope, profileScope);
}

/**
 * pass-10 blocker 3 / round-2: BATCH projector — the collision-checked scope
 * index covers the COMPLETE event domain BEFORE any projection, so
 * multi-event target-ref/profile-handle MAC collisions are detected as one
 * domain and fail closed with the bounded HANDLE_COLLISION_ERROR instead of
 * emitting ambiguous rows one event at a time. The raw scopes carry the fully
 * composed MAC inputs (`${profileId}\x00${type}:${id}` /
 * `${profileId}\x00profile:${profileId}`) because one history page spans many
 * profile salts; every projection goes through them.
 */
export function projectNamingAuditsForExternal(events: AuditEvent[]): AuditEvent[] {
  const safeEvents = events.filter(
    (event) =>
      (event.target?.kind !== 'naming-source' &&
        event.op !== 'naming.apply' &&
        event.op !== 'naming.rollback') ||
      NamingAuditEventSchema.safeParse(event).success,
  );
  const naming = safeEvents.filter((e) => e.target?.kind === 'naming-source');
  const targetScope = buildRawScope(
    'target-ref',
    naming.map((e) => {
      const target = e.target as { type: 'subscription' | 'collection'; id: string };
      const salt = e.scope === 'global' ? GLOBAL_NAMING_SCOPE_ID : e.profileId!;
      return `${salt}\x00${target.type}:${target.id}`;
    }),
  );
  const profileScope = buildRawScope(
    'profile-ref',
    naming
      .filter((e) => e.scope !== 'global' && e.profileId !== undefined)
      .map((e) => `${e.profileId}\x00profile:${e.profileId}`),
  );
  return safeEvents.map((event) =>
    projectNamingAuditForExternalWithScopes(event, targetScope, profileScope),
  );
}
