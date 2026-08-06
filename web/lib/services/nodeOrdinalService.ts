/**
 * Stable-numbering ordinal snapshot for managed naming.
 *
 * Resolves the {@link OrdinalResolver} a rename-template executor needs:
 *   - serving paths (render / export / collection stage) call with
 *     `persist: true` — atomic get-or-assign via the repo, so every caller
 *     uses the SAME authoritative ordinal and new assignments are published
 *     with the render that served them;
 *   - preview / save-preflight / assistant paths call with `persist: false`
 *     — read-only snapshot; an abandoned candidate can never change what is
 *     served (criterion 14).
 *
 * PARITY (finding 5): assignments are published ONLY for nodes that will
 * actually USE them — a node with an unambiguous upstream ordinal ("香港 05")
 * wins via the executor's upstream-first priority and never consumes an
 * assignment. The service replicates that exact check (same template +
 * recognition rules), so the persisted values are precisely the input-order
 * values read-only preview/preflight compute: preview, exact preflight,
 * first serving render, both exports and every later render agree on every
 * node, and preview/preflight never write.
 *
 * Identity comes from the envelope's immutable raw fingerprint first (the
 * same node keeps the same assignment across source and collection stages);
 * envelope-less test inputs fall back to computing the canonical hash from
 * the current object.
 */

import {
  nodeFingerprint,
  recognizeName,
  templateUsesIndexField,
  upstreamOrdinalOf,
  type OrdinalResolver,
  type RecognitionRule,
} from '@/lib/proxies/naming';
import { fingerprintOf, sourceOf, type SourceIdentity } from '@/lib/proxies/provenance';
import { allocateOrdinal, assignOrdinals, readOrdinalStore } from '@/lib/repos/nodeOrdinalRepo';
function identityOf(proxy: unknown): string | null {
  return fingerprintOf(proxy) ?? nodeFingerprint(proxy);
}

export async function resolveOrdinalsFor(
  proxies: readonly unknown[],
  sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
  options: {
    persist: boolean;
    /** The managed template — needed to replicate the executor's upstream-ordinal check. */
    template?: string;
    /** The op's saved recognition rules — same check as the executor. */
    recognitionRules?: RecognitionRule[];
  },
): Promise<OrdinalResolver> {
  const usesIndex = options.template !== undefined && templateUsesIndexField(options.template);
  const bySource = new Map<string, Array<{ fp: string; usesUpstream: boolean }>>();
  for (const proxy of proxies) {
    const source = sourceOfProxy(proxy);
    const fp = identityOf(proxy);
    if (!source || source.key === '' || fp === null) continue;
    let usesUpstream = false;
    if (usesIndex) {
      const name =
        typeof (proxy as { name?: unknown }).name === 'string'
          ? ((proxy as { name: string }).name as string)
          : '';
      if (name !== '') {
        const upstream = upstreamOrdinalOf(recognizeName(name, options.recognitionRules).base);
        usesUpstream = upstream !== null && upstream > 0;
      }
    }
    const entries = bySource.get(source.key) ?? [];
    entries.push({ fp, usesUpstream });
    bySource.set(source.key, entries);
  }

  let assignments: Map<string, Map<string, number>>;
  if (options.persist) {
    assignments = new Map();
    for (const [sourceKey, entries] of bySource) {
      // Skip nodes whose ordinal comes from the upstream suffix — their
      // assignment slot must not shift later nodes' values.
      const toAssign = entries.filter((e) => !e.usesUpstream).map((e) => e.fp);
      const unique = [...new Set(toAssign)];
      const got = await assignOrdinals(sourceKey, unique);
      assignments.set(sourceKey, got);
    }
  } else {
    const snapshot = await readOrdinalStore([...bySource.keys()]);
    // READ-ONLY PROJECTION (finding C6/C11): preview / exact preflight / AI
    // reads must produce the EXACT ordinals the first serving render will
    // publish — with zero writes. The simulation runs the SAME allocation
    // state machine as the serving Lua (allocateOrdinal / ASSIGN_ORDINALS_LUA
    // in the repo — one canonical semantics for negative, non-integer,
    // malformed, overflow, MAX_ORDINAL, hash-cap, upstream and fallback
    // behavior). The per-source counter advances only on ACCEPTED
    // allocations (rejected nodes fall back and consume nothing, exactly
    // like the Lua's read-no-write reject path), and the hash size is the
    // initial HLEN + accepted assignments so far, running across sources.
    if (snapshot.hashBroken) {
      // Wrongtype global hash: serving's eval aborts at the first HGET →
      // fail-open empty map → every node falls back to input order. The
      // projection mirrors that exactly (no reads, no writes, no ordinals).
      return () => undefined;
    }
    let totalProjected = 0;
    for (const [sourceKey, entries] of bySource) {
      // the atomic snapshot's HLEN (same eval instant as assignments +
      // counter) — a concurrent serving allocation can never tear the pair
      const hlen = snapshot.hlenBySource.get(sourceKey) ?? 0;
      const bucket = snapshot.assignments.get(sourceKey) ?? new Map<string, number>();
      const invalid = snapshot.invalidFields.get(sourceKey) ?? new Set<string>();
      let counterRaw = snapshot.counters.get(sourceKey) ?? null;
      if (snapshot.counterBroken.has(sourceKey)) {
        // Serving semantics: the counter is read ONLY when a slot is TRULY
        // missing (no existing value at all). A canonical existing value is
        // returned and a present-but-corrupt value is a rejected slot — NEITHER
        // touches the counter — so a wrongtype counter only aborts the whole
        // source eval when at least one non-upstream fp would allocate.
        const nonUpstream = entries.filter((e) => !e.usesUpstream);
        const triggersAllocation = nonUpstream.some((e) => !bucket.has(e.fp) && !invalid.has(e.fp));
        if (triggersAllocation) {
          // the serving eval aborted mid-source: NOTHING from this source
          // survives — existing values included (fail-open empty map).
          snapshot.assignments.set(sourceKey, new Map());
          continue;
        }
      }
      for (const { fp, usesUpstream } of entries) {
        if (usesUpstream) continue;
        if (bucket.has(fp)) continue;
        if (invalid.has(fp)) continue; // present-but-non-canonical → rejected slot
        const next = allocateOrdinal(counterRaw, hlen + totalProjected);
        if (next === null) continue; // fallback — mirror the Lua's reject path
        counterRaw = String(next);
        totalProjected += 1;
        bucket.set(fp, next);
      }
    }
    assignments = snapshot.assignments;
  }

  return (proxy, sourceKey) => {
    const fp = identityOf(proxy);
    if (fp === null) return undefined;
    return assignments.get(sourceKey)?.get(fp);
  };
}
