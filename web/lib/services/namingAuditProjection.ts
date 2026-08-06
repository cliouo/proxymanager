import { buildRawScope } from '@/lib/proxies/handleScopes';
import type { AuditEvent } from '@/schemas';

/**
 * pass-8 blocker 7: EXTERNAL history surfaces must never carry raw
 * entity/profile UUIDs. Naming audit events persist `target.id` + `profileId`
 * (internal, required for the atomic binding + fail-closed repository
 * validation), but every response/API/model projection replaces them with
 * keyed profile-bound tokens:
 *   - target.id  → the SAME profile-bound `ref-` token the workspace/actions
 *                  mint for that profile+target (deterministic round-trip);
 *   - profileId  → a keyed `ref-` profile handle (never the raw UUID).
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
  if (!profileId) return event;
  const target = event.target as {
    kind: 'naming-source';
    type: 'subscription' | 'collection';
    id: string;
    name: string;
  };
  return {
    ...event,
    target: { ...target, id: targetScope.project(`${profileId}\x00${target.type}:${target.id}`) },
    profileId: profileScope.project(`${profileId}\x00profile:${profileId}`),
  };
}

/** Single-event projection (test seam + single-event callers): the complete
 * domain for one event IS the event itself — one raw scope per purpose. */
export function projectNamingAuditForExternal(event: AuditEvent): AuditEvent {
  if (event.target?.kind !== 'naming-source' || event.profileId === undefined) return event;
  const targetScope = buildRawScope('target-ref', [
    `${event.profileId}\x00${(event.target as { type: string; id: string }).type}:${(event.target as { id: string }).id}`,
  ]);
  const profileScope = buildRawScope('profile-ref', [
    `${event.profileId}\x00profile:${event.profileId}`,
  ]);
  return projectNamingAuditForExternalWithScopes(event, targetScope, profileScope);
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
  const naming = events.filter(
    (e) => e.target?.kind === 'naming-source' && e.profileId !== undefined,
  );
  const targetScope = buildRawScope(
    'target-ref',
    naming.map((e) => {
      const target = e.target as { type: 'subscription' | 'collection'; id: string };
      return `${e.profileId}\x00${target.type}:${target.id}`;
    }),
  );
  const profileScope = buildRawScope(
    'profile-ref',
    naming.map((e) => `${e.profileId}\x00profile:${e.profileId}`),
  );
  return events.map((event) =>
    projectNamingAuditForExternalWithScopes(event, targetScope, profileScope),
  );
}
