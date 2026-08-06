/**
 * Authoritative caller-visible naming target scope (pass-6 blocker 1): the
 * visible set derives from the CURRENT Profile's source binding — a profile
 * bound to a subscription sees exactly that subscription; bound to a
 * collection it sees the collection AND its enabled member subscriptions;
 * an unbound (no-source) profile sees NOTHING and an absent profile mints
 * no refs. This single resolver gates target listing, ref minting, ref
 * resolution, workspace GET and POST apply/rollback — no global access.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { getProfile } from '@/lib/repos/profilesRepo';
import { getSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { getCollection } from '@/lib/services/collectionService';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { buildTargetRefScope } from '@/lib/proxies/handleScopes';
import { createHash } from 'node:crypto';
import type { Profile } from '@/schemas';

export interface NamingTarget {
  type: 'subscription' | 'collection';
  id: string;
  /** pass-8 blocker 6: the stable source key (name) the rename-template
   * executor and source aliases bind to — part of membership semantics. */
  key?: string;
  /** pass-8 blocker 6: enabled state (members are pre-filtered enabled;
   * the collection/subscription row carries its own state). */
  enabled?: boolean;
}

/** One bounded non-oracle failure for absent profile, unbound/unknown target,
 * wrong kind, zero matches and multiple matches. */
export const NAMING_SCOPE_ERROR = '目标不存在或不在当前配置文件的来源范围内。';

/** Canonical opaque target ref format shared by every model-facing surface. */
export const NAMING_REF_RE = /^ref-[0-9a-f]{16}$/;

/** The profile's naming-visible targets under the CURRENT source binding. */
export async function callerVisibleNamingTargets(profile: Profile): Promise<NamingTarget[]> {
  if (profile.source.type === 'subscription') {
    const sub = await getSubscription(profile.source.id);
    return sub ? [{ type: 'subscription', id: sub.id, key: sub.name, enabled: sub.enabled }] : [];
  }
  if (profile.source.type === 'collection') {
    const col = await getCollection(profile.source.id);
    if (!col) return [];
    // pass-9 blocker 1: the SINGLE authoritative ENABLED member set
    const members = enabledCollectionMemberSubs(col, await listSubscriptions()).map((m) => ({
      type: 'subscription' as const,
      id: m.id,
      key: m.name,
      enabled: true,
    }));
    return [
      { type: 'collection' as const, id: col.id, key: col.name, enabled: col.enabled },
      ...members,
    ];
  }
  return [];
}

/** Collect ALL exact matches inside the visible set and require exactly one
 * of the requested kind — zero, multiple and wrong-kind share the SAME
 * bounded error (never a first-match pick, never a type oracle). The
 * collision-checked index covers the COMPLETE visible domain before any
 * resolution (round-1: typed HandleScopes). */
export function resolveRefInVisibleSet(
  profileId: string,
  sourceType: 'subscription' | 'collection',
  ref: string,
  visible: readonly NamingTarget[],
): NamingTarget;
/** pass-8 blocker 5: resolve against ANY visible target kind — the ref MAC
 * already binds type+id, so the caller can authorize a ref whose kind is
 * decided by the resolution itself (one-shot analysis). */
export function resolveRefInVisibleSet(
  profileId: string,
  ref: string,
  visible: readonly NamingTarget[],
): NamingTarget;
export function resolveRefInVisibleSet(
  profileId: string,
  sourceTypeOrRef: 'subscription' | 'collection' | string,
  refOrVisible: string | readonly NamingTarget[],
  visibleOrUndefined?: readonly NamingTarget[],
): NamingTarget {
  const sourceType =
    sourceTypeOrRef === 'subscription' || sourceTypeOrRef === 'collection'
      ? sourceTypeOrRef
      : undefined;
  const ref = sourceType === undefined ? (sourceTypeOrRef as string) : (refOrVisible as string);
  const visible =
    sourceType === undefined
      ? (refOrVisible as readonly NamingTarget[])
      : (visibleOrUndefined as readonly NamingTarget[]);
  // ONE collision-checked index over the COMPLETE visible domain, then every
  // lookup through it — a MAC collision fails the bounded error before any
  // match is picked.
  const scope = buildTargetRefScope(profileId, visible);
  const matches = visible.filter((t) => scope.project(`${t.type}:${t.id}`) === ref);
  if (matches.length !== 1 || (sourceType !== undefined && matches[0].type !== sourceType)) {
    throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  }
  return matches[0];
}

/** Gate a workspace target (GET/preview/apply/rollback) against the caller's
 * profile source binding — unbound/foreign targets fail the bounded error. */
export async function requireAuthorizedNamingTarget(
  profile: Profile,
  type: 'subscription' | 'collection',
  id: string,
): Promise<void> {
  const visible = await callerVisibleNamingTargets(profile);
  if (!visible.some((t) => t.type === type && t.id === id)) {
    throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  }
}

/** Load the caller's profile; absent → the same bounded error (no refs). */
export async function requireCallerProfile(profileId: string): Promise<Profile> {
  const profile = await getProfile(profileId);
  if (!profile) {
    throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  }
  return profile;
}

/* ─── Config-version/membership bracket (pass-7 blocker 4) ─────────────
 *
 * The naming apply/rollback path enforces ONE bracket spanning auth →
 * apply → commit: the CONFIRMATION captures the profile source binding and
 * the caller-visible target set alongside the config version; the commit
 * path re-reads BOTH from current repository state immediately before the
 * CAS and fails the bounded non-oracle error when anything moved (profile
 * rebound, collection member renamed/disabled/deleted, wrong-kind/equality
 * changes) — zero writes, zero audit. The Lua CAS additionally re-validates
 * the profile's CURRENT source binding inside the same atomic eval, so the
 * version+profileId check is never the only guard.
 */

/** Canonical profile-binding form the Lua CAS compares against the live
 * profile record: `none` | `subscription:<uuid>` | `collection:<uuid>`. */
export function canonicalProfileBinding(source: Profile['source']): string {
  if (source.type === 'none') return 'none';
  return `${source.type}:${source.id}`;
}

/** Deterministic internal fingerprint over the caller-visible naming set
 * (sorted canonical rows — no raw keys cross this function). Used ONLY for
 * integrity re-checks; never projected anywhere. */
/**
 * pass-8 blocker 6: the membership fingerprint covers the EXACT visible-
 * member semantics the executor's source identity and naming bind to —
 * type, id, stable source key (name), enabled state — with deterministic
 * ordering and duplicates PRESERVED (the set is already deduped by the
 * member resolver; the fingerprint never collapses rows).
 *
 * ABA behavior: every binding/membership change above bumps config:version
 * (all are render-affecting), so a rebind A→B→A between gate and commit is
 * closed by the VERSION bracket — the CAS re-asserts the gate-captured
 * version, and the JS recheck runs immediately before the eval. Where the
 * same version cannot prove continuity (the fingerprint equals the gate
 * value but the version moved), the version gate fails closed — the
 * fingerprint is NEVER trusted alone.
 */
export function visibleSetFingerprint(profile: Profile, targets: NamingTarget[]): string {
  const canonical = targets
    .map((t) => `${t.type}:${t.id}:${t.key ?? ''}:${t.enabled === false ? 0 : 1}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export interface NamingMembershipSnapshot {
  /** Gate-captured profile source binding. */
  binding: string;
  /** Gate-captured fingerprint of the caller-visible target set. */
  visibleFingerprint: string;
  /** pass-8 blocker 6: the collection's CURRENT subscription_ids in record
   * order (duplicates preserved) — re-validated positionally by the Lua CAS
   * inside the same atomic eval for collection bindings; [] otherwise. */
  collectionMemberIds: string[];
}

/** Capture the membership bracket at the gate (before ANY entity/history
 * read) — the confirmation card carries this snapshot. */
export async function captureNamingMembership(profile: Profile): Promise<NamingMembershipSnapshot> {
  const visible = await callerVisibleNamingTargets(profile);
  let collectionMemberIds: string[] = [];
  if (profile.source.type === 'collection') {
    const col = await getCollection(profile.source.id);
    if (col) {
      collectionMemberIds = col.subscription_ids;
    }
  }
  return {
    binding: canonicalProfileBinding(profile.source),
    visibleFingerprint: visibleSetFingerprint(profile, visible),
    collectionMemberIds,
  };
}

/** Re-read the CURRENT profile + visible set and fail the bounded
 * non-oracle error on ANY change (rebind / member rename / disable /
 * delete / wrong-kind / equality). Throwing here happens BEFORE the Lua
 * eval — nothing is written, nothing is audited. */
export async function assertNamingMembershipUnchanged(
  profileId: string,
  expected: NamingMembershipSnapshot,
): Promise<void> {
  const profile = await getProfile(profileId);
  if (!profile) {
    throw ProblemDetailsError.badRequest(NAMING_SCOPE_ERROR);
  }
  if (canonicalProfileBinding(profile.source) !== expected.binding) {
    throw ProblemDetailsError.badRequest(NAMING_SCOPE_ERROR);
  }
  const visible = await callerVisibleNamingTargets(profile);
  if (visibleSetFingerprint(profile, visible) !== expected.visibleFingerprint) {
    throw ProblemDetailsError.badRequest(NAMING_SCOPE_ERROR);
  }
}
