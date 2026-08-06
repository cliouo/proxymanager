/**
 * THE shared provenance-aware global fingerprint/name dedup state machine
 * (pass-3 finding): resolve, single-subscription export and collection
 * export all run this ONE machine so preview/render/single-export/
 * collection-export produce identical identity/name sets.
 *
 * Rules (deterministic, input order = explicit source priority):
 *   1. GLOBAL raw-fingerprint true-dedup: an identity already kept by an
 *      earlier node is dropped REGARDLESS of its display name — the first
 *      keeper's source is named in the diagnostics.
 *   2. Base-name collisions (a literal base entry holds the name): a MANAGED
 *      node survives under a meaningful ` · sourceLabel` suffix (then -N);
 *      an unmanaged node is dropped (first-writer-wins against the base).
 *   3. Same-name collisions: identical fingerprints dedup by source
 *      priority; DISTINCT identities survive with the suffix when EITHER the
 *      candidate OR the first keeper is managed (per-node managed
 *      provenance — never a collection-wide boolean); otherwise the
 *      documented first-writer-wins drop applies.
 *   4. EVERY keeper — including a collision-renamed keeper — registers its
 *      fingerprint, so a later true duplicate of a suffixed keeper is still
 *      deduped (the export bug: fp2/N kept under a suffix, then fp2/M kept).
 *   5. EVERY emitted FINAL name is reserved and indexed (kept originals AND
 *      generated suffixes): a later literal name equal to an earlier
 *      generated suffix — or any emitted final — is a collision, never a
 *      silent duplicate; a distinct identity in that position survives via
 *      iterative deterministic suffixing (pass-2 finding:
 *      [fp1/N managed, fp2/N plain, fp3/"N · B" plain] → N, N · B, N · B · B).
 */

export interface DedupInputNode {
  name: string;
  /** Immutable raw identity (fingerprint); null = never identity-deduped. */
  fp: string | null;
  sourceKey: string;
  sourceLabel: string;
  /** PER-NODE managed provenance: this node's own source has an active
   * rename-template (or, for resolve, the collection stage is managed). */
  managed: boolean;
  /** Opaque caller payload (e.g. the original proxy object) — round-trips
   * untouched through the machine so callers can rebuild outputs. */
  original?: unknown;
}

export interface DedupOutputNode {
  node: DedupInputNode;
  /** The final display name (unchanged for plain keepers). */
  finalName: string;
}

export interface DedupDiagnostics {
  /** True duplicates / first-writer-wins drops. keptFrom = the keeper's
   * sourceKey (null for base-name drops); droppedFrom = the dropped node's
   * sourceKey. */
  deduped: Array<{
    kept: string;
    dropped: string;
    keptFrom: string | null;
    droppedFrom: string;
  }>;
  /** Managed-path distinct identities kept under a meaningful suffix. */
  resolved: Array<{
    from: string;
    to: string;
    keptFrom: string | null;
    droppedFrom: string;
  }>;
}

export interface DedupResult {
  kept: DedupOutputNode[];
  diagnostics: DedupDiagnostics;
}

function suffixName(name: string, label: string, taken: ReadonlySet<string>): string {
  let final = `${name} · ${label}`;
  let n = 2;
  while (taken.has(final)) {
    final = `${name} · ${label}-${n}`;
    n += 1;
  }
  return final;
}

export function dedupByNameAndIdentity(
  nodes: DedupInputNode[],
  baseNames?: ReadonlySet<string>,
): DedupResult {
  const seenFp = new Map<string, { node: DedupInputNode; sourceKey: string }>();
  /** First node that EMITTED a given ORIGINAL (raw) name — the documented
   * same-raw-name first-writer-wins policy keys on this (pass-2 finding:
   * the raw-name keeper and the final-name index are DIFFERENT books). */
  const originalByName = new Map<string, { node: DedupInputNode; sourceKey: string }>();
  /** EVERY emitted FINAL name — kept originals AND generated suffixes —
   * so a later literal name equal to an earlier generated suffix (or base
   * name) is a collision, never a silent duplicate (pass-2 finding). */
  const finalByName = new Map<string, { node: DedupInputNode; sourceKey: string }>();
  const taken = new Set<string>(baseNames ?? []);
  const kept: DedupOutputNode[] = [];
  const deduped: DedupDiagnostics['deduped'] = [];
  const resolved: DedupDiagnostics['resolved'] = [];

  for (const node of nodes) {
    if (node.name === '') {
      kept.push({ node, finalName: '' });
      continue;
    }
    // 1. GLOBAL identity dedup FIRST (before base-name/name branches) —
    //    source priority = input order, the keeper's source is named.
    if (node.fp !== null && seenFp.has(node.fp)) {
      deduped.push({
        kept: String(seenFp.get(node.fp)?.node.name ?? ''),
        dropped: node.name,
        keptFrom: seenFp.get(node.fp)?.sourceKey ?? null,
        droppedFrom: node.sourceKey,
      });
      continue;
    }
    const finalHolder = finalByName.get(node.name);
    // 2. the name is already EMITTED (as an original or a generated suffix)
    if (finalHolder !== undefined) {
      if (node.fp !== null && finalHolder.node.fp !== null && node.fp === finalHolder.node.fp) {
        deduped.push({
          kept: String(finalHolder.node.name),
          dropped: node.name,
          keptFrom: finalHolder.sourceKey,
          droppedFrom: node.sourceKey,
        });
        continue;
      }
      const rawKeeper = originalByName.get(node.name) ?? finalHolder;
      const sameRawName = rawKeeper.node.name === node.name;
      if (!sameRawName) {
        // A LITERAL name equal to a GENERATED suffix: a distinct identity
        // colliding with an emitted final — never dropped (pass-2 finding),
        // resolved by iterative deterministic suffixing.
        const final = suffixName(node.name, node.sourceLabel, taken);
        resolved.push({
          from: node.name,
          to: final,
          keptFrom: finalHolder.sourceKey,
          droppedFrom: node.sourceKey,
        });
        if (node.fp !== null) seenFp.set(node.fp, { node, sourceKey: node.sourceKey });
        if (!originalByName.has(node.name)) {
          originalByName.set(node.name, { node, sourceKey: node.sourceKey });
        }
        finalByName.set(final, { node, sourceKey: node.sourceKey });
        taken.add(final);
        kept.push({ node, finalName: final });
        continue;
      }
      // 3. same-raw-name collisions: managed path survives under a
      //    deterministic suffix; plain/plain keeps first-writer-wins.
      if (!(node.managed || rawKeeper.node.managed)) {
        deduped.push({
          kept: String(rawKeeper.node.name),
          dropped: node.name,
          keptFrom: rawKeeper.sourceKey,
          droppedFrom: node.sourceKey,
        });
        continue;
      }
      const final = suffixName(node.name, node.sourceLabel, taken);
      resolved.push({
        from: node.name,
        to: final,
        keptFrom: rawKeeper.sourceKey,
        droppedFrom: node.sourceKey,
      });
      if (node.fp !== null) seenFp.set(node.fp, { node, sourceKey: node.sourceKey });
      if (!originalByName.has(node.name)) {
        originalByName.set(node.name, { node, sourceKey: node.sourceKey });
      }
      finalByName.set(final, { node, sourceKey: node.sourceKey });
      taken.add(final);
      kept.push({ node, finalName: final });
      continue;
    }
    // 4. base-name collisions (no emitted final holds the name)
    if (baseNames?.has(node.name)) {
      if (!node.managed) {
        deduped.push({
          kept: node.name,
          dropped: node.name,
          keptFrom: null,
          droppedFrom: node.sourceKey,
        });
        continue;
      }
      const final = suffixName(node.name, node.sourceLabel, taken);
      resolved.push({
        from: node.name,
        to: final,
        keptFrom: null,
        droppedFrom: node.sourceKey,
      });
      if (node.fp !== null) seenFp.set(node.fp, { node, sourceKey: node.sourceKey });
      originalByName.set(node.name, { node, sourceKey: node.sourceKey });
      finalByName.set(final, { node, sourceKey: node.sourceKey });
      taken.add(final);
      kept.push({ node, finalName: final });
      continue;
    }
    // 5. plain keeper
    if (node.fp !== null) seenFp.set(node.fp, { node, sourceKey: node.sourceKey });
    originalByName.set(node.name, { node, sourceKey: node.sourceKey });
    finalByName.set(node.name, { node, sourceKey: node.sourceKey });
    taken.add(node.name);
    kept.push({ node, finalName: node.name });
  }
  return { kept, diagnostics: { deduped, resolved } };
}
