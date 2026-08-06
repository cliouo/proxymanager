/**
 * Trusted internal src-handle ↔ stable-key translation for rename-template
 * source aliases (pass-6 blocker 2, pass-8 blocker 1): every
 * model/API/external/diagnostic surface carries ONLY opaque src-* handles —
 * stable source keys/slugs and the old s0/s1 ordinals never cross. External
 * payloads must be src-only (plain stable keys, mixed forms, duplicates
 * after translation and MAC collisions all fail closed with ONE bounded,
 * insertion-order-independent error and no writes); read projections
 * translate stored stable keys to handles and DROP every key outside the
 * entity's current authoritative source-key set — an orphan/renamed/
 * disabled/deleted/ref-like/UUID-like stored key is never returned
 * verbatim. The trusted server-side apply boundary performs the single
 * reverse translation using the entity's authoritative source-key set.
 * Reverse maps stay local to the call.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { buildOpaqueSourceIndexFromKeys, type OpaqueSourceIndex } from '@/lib/ai/namingAnalysis';
import { EXTERNAL_SRC_KEY_RE, ALIAS_ERROR } from '@/schemas/externalAliases';

/**
 * Strict external-input gate: EVERY alias key must be an opaque src- handle.
 * Plain stable keys, s0/s1-style keys and mixed forms are rejected with the
 * same bounded error regardless of insertion order.
 */
export function assertExternalAliasKeys(aliases: Record<string, string> | undefined): void {
  if (aliases === undefined) return;
  for (const key of Object.keys(aliases)) {
    if (!EXTERNAL_SRC_KEY_RE.test(key)) {
      throw ProblemDetailsError.badRequest(ALIAS_ERROR);
    }
  }
}

/**
 * The SINGLE trusted reverse translation (immediately before authorized
 * apply): src-handle keys map to stable keys via the entity's authoritative
 * source-key set. Rejects invented/unmapped handles, MAC collisions and
 * duplicate-after-translation cases — one bounded error, order-independent.
 * Plain keys are NOT accepted here either (no heuristic pass-through).
 */
export function resolveSourceAliasKeys(
  aliases: Record<string, string> | undefined,
  sourceKeys: Iterable<string>,
): Record<string, string> | undefined {
  if (aliases === undefined || Object.keys(aliases).length === 0) return aliases;
  let index: OpaqueSourceIndex;
  try {
    index = buildOpaqueSourceIndexFromKeys(sourceKeys);
  } catch {
    // a source-MAC collision is ambiguous — the SAME bounded failure
    throw ProblemDetailsError.badRequest(ALIAS_ERROR);
  }
  const seenStable = new Set<string>();
  const out: Record<string, string> = {};
  for (const [key, alias] of Object.entries(aliases)) {
    if (!EXTERNAL_SRC_KEY_RE.test(key)) {
      throw ProblemDetailsError.badRequest(ALIAS_ERROR);
    }
    const stable = index.idToKey.get(key);
    if (stable === undefined || seenStable.has(stable)) {
      throw ProblemDetailsError.badRequest(ALIAS_ERROR);
    }
    seenStable.add(stable);
    out[stable] = alias;
  }
  return out;
}

/**
 * pass-8 blocker 1 — TOTAL fail-closed read projection: stored stable-key
 * aliases become opaque src- handles. Every key OUTSIDE the entity's
 * current authoritative source-key set — orphan legacy keys, renamed/
 * disabled/deleted sources, stale src-like/ref-like/UUID-like artifacts —
 * is DROPPED, never returned verbatim. A source-handle MAC collision inside
 * the authoritative set is ambiguous and fails the same bounded error.
 */
export function projectAliasKeysToHandles(
  aliases: Record<string, string> | undefined,
  sourceKeys: Iterable<string>,
): Record<string, string> | undefined {
  if (aliases === undefined || Object.keys(aliases).length === 0) return aliases;
  let index: OpaqueSourceIndex;
  try {
    index = buildOpaqueSourceIndexFromKeys(sourceKeys);
  } catch {
    // a source-MAC collision is ambiguous — the SAME bounded failure
    throw ProblemDetailsError.badRequest(ALIAS_ERROR);
  }
  const out: Record<string, string> = {};
  for (const [key, alias] of Object.entries(aliases)) {
    const handle = index.keyToId.get(key);
    if (handle === undefined) continue; // DROP orphan/stale/renamed/disabled/deleted keys
    out[handle] = alias;
  }
  return out;
}
