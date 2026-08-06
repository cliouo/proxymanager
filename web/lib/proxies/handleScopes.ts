/**
 * Typed HandleScopes — opaque identifiers as authorization/reference tokens.
 *
 * Round-1 design (Architecture C): every semantic handle factory binds its
 * purpose (a distinct MAC domain tag) and its scope (a salt), builds ONE
 * collision-checked index over the COMPLETE authorized domain BEFORE any
 * cap/projection/reverse lookup, and then performs every forward/reverse
 * operation through that index. Building the index after a slice/cap or
 * resolving outside the index is a prohibited bypass: a collision whose
 * second row lies beyond a cap must still fail the response closed.
 *
 * Actual domains (invariant 8):
 *   - target refs  = the caller profile's complete current visible target
 *                    union (`${type}:${id}` identities under the profile salt);
 *   - profile refs = the complete consuming-profile set of one response;
 *   - source refs  = the exact target's complete enabled source-key set;
 *   - operator refs= the exact target's ENTIRE stored operator list
 *                    (parked rows included — their synthetic ids are part of
 *                    the domain);
 *   - node refs    = the exact authorized raw node snapshot, including rows
 *                    beyond samples (occurrence/fingerprint identities);
 *   - local-node refs = the complete parsed local source.
 *
 * Each scope uses a DISTINCT semantic MAC domain tag (target-ref /
 * profile-ref / source / operator / node) even though the token-level
 * compatibility prefixes (ref-/src-/op-/nd-) remain — a handle minted in one
 * purpose can never validate in another purpose's scope.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { HANDLE_COLLISION_ERROR } from './handleIndex';
import { handleSigner, type HandleSigner } from './handles';

/** Semantic MAC domain tags — one per handle purpose. */
export type ScopeMacDomain = 'target-ref' | 'profile-ref' | 'source' | 'operator' | 'node';

/**
 * The token-level compatibility prefix for each semantic domain. Round-3:
 * prefixes live HERE (not in handles.ts) — the scope builders compose
 * `${prefix}-${signer.mac(domain, input)}` while building the complete maps.
 */
const SCOPE_TOKEN_PREFIXES: Record<ScopeMacDomain, string> = {
  'target-ref': 'ref',
  'profile-ref': 'ref',
  source: 'src',
  operator: 'op',
  node: 'nd',
};

/** The SOLE semantic token constructor: compatibility prefix + keyed MAC. */
function semanticToken(
  macDomain: ScopeMacDomain,
  text: string,
  signer: HandleSigner = handleSigner(),
): string {
  return `${SCOPE_TOKEN_PREFIXES[macDomain]}-${signer.mac(macDomain, text)}`;
}

/**
 * One collision-checked handle scope. `project`/`resolve` operate through the
 * prebuilt index — the identity set is fixed at build time (the COMPLETE
 * authorized domain); resolving a handle that was never indexed returns null
 * (callers map null to their own bounded stale/not-found error).
 */
export interface TypedHandleScope<T extends string> {
  /** Number of distinct identities in the domain (duplicates collapse). */
  readonly size: number;
  /** Forward: identity → handle. An unindexed identity fails the bounded
   * scope error (never mints an out-of-domain handle). */
  project(identity: T): string;
  /** Reverse: handle → identity; null when the handle is not in the domain.
   * The index is collision-checked at build time, so a present handle maps
   * to exactly one identity. */
  resolve(handle: string): T | null;
  /** True when the handle belongs to this scope's domain. */
  has(handle: string): boolean;
}

/**
 * Build a typed scope over raw MAC inputs (advanced/batch use — e.g. a
 * history page whose events span multiple profile salts). Each input is the
 * FULL MAC text (`${salt}\x00${identity}`); project() emits
 * `${prefix}-${hmac(macDomain, input)}`.
 *
 * Round-2 (Decision 2): the scope owns BOTH maps — handleByIdentity and
 * identityByHandle. Construction deduplicates only repeated occurrences of
 * the SAME semantic identity and rejects one handle mapped to two distinct
 * identities. project() returns ONLY handleByIdentity.get(exactIdentity) —
 * an out-of-domain identity fails the bounded scope error even when its
 * recomputed handle collides with an indexed identity (a constant signer
 * must never authorize an unindexed identity). resolve() returns only the
 * pre-indexed exact identity.
 */
export function buildRawScope(
  macDomain: ScopeMacDomain,
  inputs: Iterable<string>,
  signer?: HandleSigner,
  options: { skipEmpty?: boolean; rejectDuplicates?: boolean } = {},
): TypedHandleScope<string> {
  // `options` is an ordinary internal object. Own-only reads prevent a
  // polluted Object.prototype getter from changing scope policy or turning
  // handle projection into a process-local denial of service.
  const skipEmpty = Object.hasOwn(options, 'skipEmpty') ? options.skipEmpty === true : true;
  const rejectDuplicates = Object.hasOwn(options, 'rejectDuplicates')
    ? options.rejectDuplicates === true
    : false;
  const handleByIdentity = new Map<string, string>();
  const identityByHandle = new Map<string, string>();
  for (const input of inputs) {
    if (input === '' && skipEmpty) continue;
    if (handleByIdentity.has(input)) {
      if (rejectDuplicates) {
        // an ID-only handle cannot identify two rows — bounded ambiguity
        throw ProblemDetailsError.badRequest(HANDLE_COLLISION_ERROR);
      }
      continue; // repeated occurrence of the SAME semantic identity
    }
    const handle = semanticToken(macDomain, input, signer);
    if (identityByHandle.has(handle)) {
      // ONE handle mapped to TWO DISTINCT identities — ambiguous
      throw ProblemDetailsError.badRequest(HANDLE_COLLISION_ERROR);
    }
    handleByIdentity.set(input, handle);
    identityByHandle.set(handle, input);
  }
  return {
    size: handleByIdentity.size,
    project(identity) {
      const handle = handleByIdentity.get(identity);
      if (handle === undefined) {
        throw ProblemDetailsError.badRequest(HANDLE_COLLISION_ERROR);
      }
      return handle;
    },
    resolve(handle) {
      return identityByHandle.get(handle) ?? null;
    },
    has(handle) {
      return identityByHandle.has(handle);
    },
  };
}

function buildSaltedScope(
  macDomain: ScopeMacDomain,
  salt: string,
  identities: Iterable<string>,
  signer?: HandleSigner,
): TypedHandleScope<string> {
  const scope = buildRawScope(
    macDomain,
    (function* compose() {
      for (const identity of identities) {
        if (identity === '') continue;
        yield `${salt}\x00${identity}`;
      }
    })(),
    signer,
  );
  // Re-wrap so project() takes the UNSALTED identity and composes the salt.
  // Out-of-domain identities fail closed through the raw scope (never mint
  // an unindexed handle).
  return {
    size: scope.size,
    project(identity) {
      return scope.project(`${salt}\x00${identity}`);
    },
    resolve(handle) {
      const input = scope.resolve(handle);
      if (input === null) return null;
      return input.startsWith(`${salt}\x00`) ? input.slice(salt.length + 1) : input;
    },
    has(handle) {
      return scope.has(handle);
    },
  };
}

/**
 * Target-ref scope: the caller profile's COMPLETE current visible target
 * union. Identities are `${type}:${id}` for every visible target; the
 * profile id salts every handle so a ref can never be replayed across
 * profiles. project() emits the SAME bytes as the historical single-target
 * mint (namingTargetRefOf) — only the MAC domain tag is now purpose-specific.
 */
export function buildTargetRefScope(
  profileId: string,
  targets: Iterable<{ type: 'subscription' | 'collection'; id: string }>,
  signer?: HandleSigner,
): TypedHandleScope<string> {
  return buildSaltedScope(
    'target-ref',
    profileId,
    (function* compose() {
      for (const target of targets) yield `${target.type}:${target.id}`;
    })(),
    signer,
  );
}

/**
 * Profile-ref scope: the complete consuming-profile set of one response.
 * Identities are the raw profile ids under the CALLER's profile salt,
 * composed as `profile:<id>` (semantic disambiguation from target refs).
 */
export function buildProfileScope(
  callerProfileId: string,
  profileIds: Iterable<string>,
  signer?: HandleSigner,
): TypedHandleScope<string> {
  return buildSaltedScope(
    'profile-ref',
    callerProfileId,
    (function* compose() {
      for (const id of profileIds) yield `profile:${id}`;
    })(),
    signer,
  );
}

/**
 * Source-alias scope: the exact target's COMPLETE enabled source-key set.
 * Identities are the stable source keys (slugs); no salt — the key set is
 * already target-scoped by construction. The anonymous-source key ('') is a
 * first-class identity here (projectHealth's no-provenance reports) — the
 * deterministic single handle for it stays inside the indexed domain.
 */
export function buildSourceAliasScope(
  keys: Iterable<string>,
  signer?: HandleSigner,
): TypedHandleScope<string> {
  return buildRawScope('source', keys, signer, { skipEmpty: false });
}

/**
 * Operator scope: the exact target's ENTIRE stored operator list — parked
 * rows included (their synthetic parked-N ids are part of the domain, so a
 * list with parked rows still indexes unambiguously). Duplicate IDs in ONE
 * pipeline are REJECTED (round-2): an ID-only handle cannot identify two
 * rows, so a retained duplicate id is ambiguous and fails bounded.
 */
export function buildOperatorScope(
  ids: Iterable<string>,
  signer?: HandleSigner,
): TypedHandleScope<string> {
  return buildRawScope('operator', ids, signer, { rejectDuplicates: true });
}

/**
 * Node scope: the exact authorized raw node snapshot (rows beyond samples
 * included). Identities are the per-node identity texts
 * (`${rawName}\x00${fingerprint}\x00${occurrence}` for pipeline nodes;
 * `${position}\x00${name}` for local-source nodes); the scope salt binds the
 * snapshot to its source (profile+source for local nodes).
 */
export function buildNodeScope(
  salt: string,
  identities: Iterable<string>,
  signer?: HandleSigner,
): TypedHandleScope<string> {
  return salt === ''
    ? buildRawScope('node', identities, signer)
    : buildSaltedScope('node', salt, identities, signer);
}
