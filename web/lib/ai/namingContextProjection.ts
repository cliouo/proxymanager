/**
 * AiSafeNamingContext — the SINGLE shared projector for model-visible node and
 * source facts (round-1 design, Architecture B).
 *
 * Product contract (invariant 6/7/9): AI tools are authorized to see
 * caller-profile-authorized, bounded, sanitized display content needed for
 * recognition — sampled original node display names, sampled before/after
 * names, safe source display labels, canonical protocol, inferred facts,
 * counts, confidence, and safe current/candidate recognition-rule text.
 * A display-name field is user content authorized to the configured model
 * after structural credential redaction; an arbitrary short secret
 * deliberately placed in a display-name field is indistinguishable from a
 * name and outside any honest automatic guarantee.
 *
 * The projector:
 *   - builds ONE collision-checked node scope over the COMPLETE authorized
 *     raw snapshot (rows beyond samples included) and ONE source-alias scope
 *     over the complete source-key set BEFORE any cap/projection — every
 *     forward/reverse operation then goes through those indexes;
 *   - redacts the FULL name before it can leave (recognition never runs on
 *     raw text), collapses + bounds the residue, and drops the field when
 *     nothing safe remains;
 *   - allows only the shared production protocol enum (canonicalProxyType);
 *   - reports truthful totals + truncation (the sample cap is never the
 *     true total).
 *
 * Prohibited bypasses: replacing useful display text with opaque value/rule
 * tokens, building handle indexes after a slice/cap, per-event history
 * projection without a complete-domain scope, raw DB ids / stable storage
 * keys / connection fields / credentials / fingerprints in model payloads,
 * and logging raw inputs or model payloads.
 */

import {
  buildNodeScope,
  buildSourceAliasScope,
  type TypedHandleScope,
} from '@/lib/proxies/handleScopes';
import {
  canonicalProxyType,
  containsSensitivePattern,
  redactSensitiveText,
} from '@/lib/proxies/namingSanitize';
import { envelopeOf, fingerprintOf, sourceOf, type SourceIdentity } from '@/lib/proxies/provenance';
import { nodeFingerprint } from '@/lib/proxies/naming';

/** Upper bound for any display text (node names, source labels, samples). */
export const DISPLAY_TEXT_MAX = 48;

/** Upper bound for short fact/sample fragments. */
export const SAMPLE_TEXT_MAX = 24;

/**
 * Sanitize a display string for model-facing surfaces: redact every
 * credential-shaped span (URLs, hosts/IPs/ports, UUIDs, tokens, keys,
 * cookies/headers, query strings), collapse whitespace, bound, and return
 * null when nothing safe remains. Safe labels such as HK-01, IPLC, Nexitally,
 * 2x, 家宽 and ordinary source display names survive.
 */
export function sanitizeDisplayText(text: string, bound: number = DISPLAY_TEXT_MAX): string | null {
  const cleaned = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, bound);
}

/** Sanitized display label for a source identity (label or key fallback). */
export function safeSourceLabel(identity: SourceIdentity | undefined, key: string): string | null {
  if (identity !== undefined && identity.label !== '') {
    return sanitizeDisplayText(identity.label);
  }
  return sanitizeDisplayText(key);
}

export interface ProjectedNode {
  /** Opaque node ref (nd-…) — the ONLY identity the model may reuse. */
  handle: string;
  /** Bounded sanitized original display name; null when nothing safe remains. */
  name: string | null;
  /** Canonical protocol (shared production enum) or null. */
  protocol: string | null;
}

export interface ProjectedSource {
  /** Opaque src- handle — never the raw stable key. */
  id: string;
  /** Bounded sanitized display label; null when nothing safe remains. */
  label: string | null;
}

export interface NodeSnapshotProjection {
  /** EVERY node of the snapshot (indexed) — consumers cap afterwards. */
  nodes: ProjectedNode[];
  /** EVERY distinct source of the snapshot. */
  sources: ProjectedSource[];
  nodeCount: number;
  sourceTotal: number;
}

/**
 * Occurrence-aware node identity: raw name + immutable fingerprint +
 * per-list occurrence (same semantics as the historical handleOf) — the
 * MAC INPUT for the node scope. Exact duplicates differ by occurrence;
 * same-name different-config nodes differ by fingerprint.
 */
export function nodeIdentityOf(
  proxy: unknown,
  occurrences: Map<string, number>,
): { identity: string; rawName: string; fingerprint: string | null } {
  const envelope = envelopeOf(proxy);
  const rawName =
    envelope?.rawName ??
    (typeof (proxy as { name?: unknown }).name === 'string'
      ? ((proxy as { name: string }).name as string)
      : '');
  const fp = fingerprintOf(proxy) ?? nodeFingerprint(proxy);
  const key = `${rawName}\x00${fp ?? ''}`;
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return { identity: `${rawName}\x00${fp ?? ''}\x00${occurrence}`, rawName, fingerprint: fp };
}

/**
 * Build ONE collision-checked node scope over the COMPLETE snapshot (all
 * rows, including rows beyond any sample cap). The occurrence map is
 * computed over the full list BEFORE the scope is built — a collision whose
 * second row lies beyond a cap still fails the response closed.
 */
export function buildNodeSnapshotScope(proxies: readonly unknown[]): {
  scope: TypedHandleScope<string>;
  identities: string[];
} {
  const occurrences = new Map<string, number>();
  const identities = proxies.map((proxy) => nodeIdentityOf(proxy, occurrences).identity);
  return { scope: buildNodeScope('', identities), identities };
}

/**
 * Project a raw node snapshot: opaque node refs + sanitized display names +
 * canonical protocol, plus sanitized source labels. All handle operations go
 * through the complete-domain indexes; all text through sanitizeDisplayText.
 */
export function projectNodeSnapshot(
  proxies: readonly unknown[],
  options: { sourceOfProxy?: (proxy: unknown) => SourceIdentity | undefined } = {},
): NodeSnapshotProjection {
  const sourceOfProxy = options.sourceOfProxy ?? sourceOf;
  const { scope, identities } = buildNodeSnapshotScope(proxies);
  const nodes: ProjectedNode[] = proxies.map((proxy, i) => {
    const name =
      typeof (proxy as { name?: unknown }).name === 'string'
        ? ((proxy as { name: string }).name as string)
        : '';
    const type = (proxy as { type?: unknown }).type;
    return {
      handle: scope.project(identities[i]),
      name: name === '' ? null : sanitizeDisplayText(name),
      protocol: typeof type === 'string' && type !== '' ? canonicalProxyType(type) : null,
    };
  });
  const sourceKeys = new Set<string>();
  const labelByKey = new Map<string, string | null>();
  for (const proxy of proxies) {
    const identity = sourceOfProxy(proxy);
    if (identity && identity.key !== '') {
      sourceKeys.add(identity.key);
      if (!labelByKey.has(identity.key)) {
        labelByKey.set(identity.key, safeSourceLabel(identity, identity.key));
      }
    }
  }
  const sourceScope = buildSourceAliasScope(sourceKeys);
  const sources: ProjectedSource[] = [...sourceKeys].map((key) => ({
    id: sourceScope.project(key),
    label: labelByKey.get(key) ?? null,
  }));
  return { nodes, sources, nodeCount: proxies.length, sourceTotal: sources.length };
}

/** Bounded name-sample payload with truthful totals (before/after lists). */
export function nameSamplesPayload(
  names: readonly string[],
  cap: number,
): { names: Array<string | null>; sampled: number; total: number; truncated: boolean } {
  const samples = names.slice(0, cap).map((name) => sanitizeDisplayText(name));
  return {
    names: samples,
    sampled: samples.length,
    total: names.length,
    truncated: names.length > cap,
  };
}

/**
 * Server-minted opaque handle tokens (src-/nd-/ref-/op-/r-/v- + 16 hex) are
 * authorization tokens, not credentials — the recursive scan exempts them
 * (their 16-hex MAC tail would otherwise match the uuid-like-hex pattern).
 */
const OPAQUE_HANDLE_RE = /^(?:src|nd|ref|op|r|v)-[0-9a-f]{16}$/;

/**
 * Recursive credential-free assertion over ANY model-facing payload (input
 * payloads, suggestion outputs, diffs, errors): every string must be free of
 * credential-shaped spans (containsSensitivePattern) and bounded. Throws a
 * plain credential-free Error — never logs the offending value.
 */
export function assertModelPayloadSafe(value: unknown, maxString = 512, depth = 0): void {
  if (depth > 12) throw new Error('Model payload exceeds nesting bound.');
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length > maxString) {
      throw new Error('Model payload string exceeds size bound.');
    }
    if (!OPAQUE_HANDLE_RE.test(value) && containsSensitivePattern(value)) {
      throw new Error('Model payload carries credential-shaped material.');
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item) => assertModelPayloadSafe(item, maxString, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      assertModelPayloadSafe(child, maxString, depth + 1);
    }
  }
}
