/**
 * Per-node envelope for the node-processing pipeline.
 *
 * The `rename-template` operator needs to know which subscription a node came
 * from (source alias + per-source numbering), and — for true identity-based
 * dedup and stable numbering — the node's RAW identity fingerprint computed at
 * the fetch boundary, BEFORE any preprocessing operator could change its
 * canonical config. Only that immutable fingerprint survives across source and
 * collection stages, so the same node gets the same assignment no matter which
 * stage names it.
 *
 * Provenance is carried on an **enumerable Symbol**:
 *   - object spread (`{...p}`) — the only transform the operators do —
 *     preserves enumerable symbols, so provenance survives every rename /
 *     filter / sort / dedup step;
 *   - `Object.entries`, `JSON.stringify` and YAML serialisation never see
 *     symbols, so a node can never leak its internal source metadata or
 *     identity fingerprint into a serialised Clash/Mihomo document or public
 *     API response.
 */

export interface SourceIdentity {
  /** Stable source key — the subscription slug (`name`). Used for alias overrides. */
  key: string;
  /** Human-facing alias — `display_name` when set, else the slug. */
  label: string;
}

/**
 * Internal per-node metadata. Every field is server-only: none of it may
 * ever enter management responses, assistant payloads or serialised configs.
 */
export interface NodeEnvelope {
  /** The node's source subscription identity. */
  source?: SourceIdentity;
  /** Original name at the raw fetch boundary (pre-any-operator). */
  rawName?: string;
  /**
   * Immutable raw-identity fingerprint: canonical hash over the node's
   * connection-defining config as fetched upstream. Computed ONCE at the
   * fetch boundary; later stages reuse it instead of re-hashing the
   * post-preprocessing object, so identity never drifts when a set-prop /
   * flag / rename step changed other fields.
   */
  fingerprint?: string;
}

/** Well-known symbol every pipeline path attaches/reads through. */
export const NODE_ENVELOPE: unique symbol = Symbol('node-envelope');

export type ProvenancedProxy = Record<string, unknown> & { [NODE_ENVELOPE]?: NodeEnvelope };

/** Attach (or replace) the envelope on a proxy object. */
export function withEnvelope(
  proxy: Record<string, unknown>,
  envelope: NodeEnvelope,
): ProvenancedProxy {
  return { ...proxy, [NODE_ENVELOPE]: envelope };
}

/**
 * Attach (or replace) the source identity on a proxy object. MERGES into any
 * existing envelope: the collection stage re-attaches a member source over
 * nodes that already carry the fetch-boundary fingerprint/rawName, and those
 * immutable identity fields must survive (a node's true identity can never
 * depend on which stage is naming it).
 */
export function withSource(
  proxy: Record<string, unknown>,
  identity: SourceIdentity,
): ProvenancedProxy {
  return mergeEnvelope(proxy, { source: identity });
}

/** Merge partial envelope fields into the existing envelope (if any). */
export function mergeEnvelope(
  proxy: Record<string, unknown>,
  partial: NodeEnvelope,
): ProvenancedProxy {
  const existing = envelopeOf(proxy);
  return { ...proxy, [NODE_ENVELOPE]: { ...(existing ?? {}), ...partial } };
}

/** Read the envelope, or undefined when the node carries none. */
export function envelopeOf(proxy: unknown): NodeEnvelope | undefined {
  if (!proxy || typeof proxy !== 'object') return undefined;
  return (proxy as ProvenancedProxy)[NODE_ENVELOPE];
}

/** Read the source identity, or undefined when the node carries none. */
export function sourceOf(proxy: unknown): SourceIdentity | undefined {
  return envelopeOf(proxy)?.source;
}

/** Read the immutable raw fingerprint, or null. */
export function fingerprintOf(proxy: unknown): string | null {
  const fp = envelopeOf(proxy)?.fingerprint;
  return typeof fp === 'string' && fp !== '' ? fp : null;
}

/** Remove the envelope from a proxy object (boundary serialisation helper). */
export function stripSource<T extends Record<string, unknown>>(proxy: T): T {
  if (!(NODE_ENVELOPE in proxy)) return proxy;
  const out = { ...proxy };
  delete (out as ProvenancedProxy)[NODE_ENVELOPE];
  return out as T;
}
