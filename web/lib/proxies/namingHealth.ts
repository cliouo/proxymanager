/**
 * Source-recognition health reporting for the 智能命名 workspace.
 *
 * Criterion 7: recognition produces typed facts with per-field confidence and
 * provenance; the system reports exact coverage counts and percentages for
 * every available placeholder, distinguishes intrinsic / derived / ai-rule /
 * assigned VALUES (not just a coarse source kind), exposes bounded sanitized
 * representative values and opaque handles only, and reports unavailable,
 * partial, ambiguous and drifted patterns. Unknown values stay unknown — no
 * AI hallucination becomes a runtime fact without a saved validated rule.
 *
 * Pure + deterministic: same nodes ⇒ same report. All string outputs are
 * bounded and redacted (sanitizeFragment) because reports can flow into
 * assistant payloads; node references are INTERNAL identities (raw name +
 * fingerprint + occurrence) — external surfaces project them through the
 * typed node HandleScope (round-1: no handle minting inside analysis).
 */

import {
  NAMING_FIELDS,
  nodeFingerprint,
  recognizeName,
  upstreamOrdinalOf,
  type NamingField,
} from './naming';
import { sanitizeFragment } from './namingSanitize';
import { envelopeOf, fingerprintOf, sourceOf, type SourceIdentity } from './provenance';

/** Field provenance classification — per VALUE, not per source. */
export type FieldKind = 'intrinsic' | 'derived' | 'ai-rule' | 'assigned';

/** Recognition fact confidence (unknown = fact absent). */
export type FactConfidence = 'high' | 'medium' | 'low';

/** Bounded representative sample (already redacted + truncated). */
export interface FieldSample {
  value: string;
  count: number;
  /** Provenance of THIS value (a rule-produced value is ai-rule). */
  kind: FieldKind;
  /** Confidence of THIS value (rules ⇒ high, tables ⇒ medium, conflicts ⇒ low). */
  confidence: FactConfidence;
}

export interface FieldCoverage {
  field: NamingField;
  /** Nodes where the field resolved to a value. */
  present: number;
  /** Total nodes considered. */
  total: number;
  /** present / total, 0..100 (rounded). */
  percent: number;
  /** Human label for the placeholder (UI + assistant). */
  label: string;
  /** Confidence distribution across present values. */
  confidence: { high: number; medium: number; low: number };
  /** Representative distinct values, frequency-desc, bounded. */
  samples: FieldSample[];
  /** TRUE distinct-value count — never the sample cap (pass-1 finding). */
  sampleTotal: number;
  /** True when more distinct values exist beyond the stored samples. */
  sampleTruncated: boolean;
}

/** One node's typed facts — opaque handle + per-field value/confidence/provenance. */
export interface NodeFact {
  /** Opaque node handle (nd-… keyed HMAC-SHA256 token) — the only node identifier that leaves the server. */
  node: string;
  field: NamingField;
  /** Bounded, redacted value; null = unknown (fact absent). */
  value: string | null;
  confidence: FactConfidence | null;
  kind: FieldKind | null;
  /** True when conflicting signals produced this fact (flag vs keyword etc.). */
  ambiguous: boolean;
}

export interface DriftReport {
  /** The field whose pattern no longer fires as expected. */
  field: NamingField;
  /** TRUE count of nodes carrying the near-miss pattern — never the stored
   * sample cap (pass-1 finding). */
  count: number;
  /** Bounded, redacted residual samples. */
  samples: string[];
  /** True when more samples exist beyond the stored view. */
  samplesTruncated: boolean;
}

export interface SourceHealthReport {
  /** Stable source key (slug). */
  sourceKey: string;
  /** Safe label (redacted + bounded). */
  sourceLabel: string;
  nodeCount: number;
  fields: FieldCoverage[];
  /** Per-node typed facts — bounded view (first {@link NODE_FACT_CAP} nodes). */
  nodeFacts: NodeFact[];
  /** TRUE FACT-ROW count for the listing — the semantic unit of nodeFacts,
   * never the stored cap and never the node count (pass-2 finding). */
  nodeFactsTotal: number;
  /** True when more fact rows exist beyond the stored view. */
  nodeFactsTruncated: boolean;
  /** Fields with zero coverage — unavailable in this source. */
  unavailable: NamingField[];
  /** Fields with 1..99% coverage — partially available. */
  partial: NamingField[];
  /** Nodes with at least one ambiguous fact. */
  ambiguousCount: number;
  /** Near-miss patterns in residuals — upstream drifted from the tables. */
  drift: DriftReport[];
}

const FIELD_LABELS: Record<NamingField, string> = {
  emoji: '国旗',
  region: '地区（中文）',
  region_code: '地区（代码）',
  entry: '入口',
  route: '路由',
  vendor: '服务商',
  source: '来源',
  protocol: '协议',
  rate: '倍率',
  index: '序号',
  note: '残余片段',
};

/** Intrinsic: the value is structured data, not inferred. */
const INTRINSIC_FIELDS: ReadonlySet<NamingField> = new Set(['protocol']);

/** Assigned: provided by the naming stage itself (always available). */
const ASSIGNED_FIELDS: ReadonlySet<NamingField> = new Set(['source', 'index']);

/** Bounded sample counts per field. */
export const SAMPLE_CAP = 3;
/** Bounded per-node fact listing. */
export const NODE_FACT_CAP = 40;
/** Bounded number of drift entries per source. */
export const DRIFT_CAP = 5;
/** Bounded near-miss sample length. */
export const DRIFT_SAMPLE_MAX = 24;

/**
 * Near-miss patterns: a token in the residual that LOOKS like a field signal
 * but did not match the bounded tables — e.g. an out-of-bounds rate, a
 * foreign flag emoji, or an unknown route word. These are the actionable
 * drift signals: upstream renamed its convention and recognition stopped
 * firing.
 */
const DRIFT_PATTERNS: ReadonlyArray<{ field: NamingField; re: RegExp }> = [
  { field: 'rate', re: /\d{4,}[x×]|[x×]\d{1,3}(?![0-9A-Za-z])/ },
  { field: 'route', re: /(?:专线|优化|普线|家宽|原生|隧道)/ },
  // A flag emoji that maps to NO region in the table (e.g. an exotic code).
  { field: 'region', re: /[\u{1F1E6}-\u{1F1FF}]{2}/u },
];

function topSamples(
  counts: Map<string, { count: number; kind: FieldKind; confidence: FactConfidence }>,
  cap = SAMPLE_CAP,
): FieldSample[] {
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([value, meta]) => ({ value, ...meta }));
}

/**
 * INTERNAL per-node reference (round-1 design, Architecture B): namingHealth
 * is internal analysis — it emits the deterministic node IDENTITY (raw name
 * + immutable identity fingerprint + per-list occurrence), never a MAC
 * handle. Every external projection (assistant actions, workspace route)
 * builds ONE collision-checked typed node scope over the COMPLETE snapshot
 * and projects identities through it (handleScopes.buildNodeScope /
 * namingContextProjection). The identity is unique per node within one
 * analysis run; same-name different-config nodes differ by fingerprint and
 * exact duplicates by occurrence.
 */
function nodeIdentity(name: string, fingerprint?: string | null, occurrence = 0): string {
  return `${name}\x00${fingerprint ?? ''}\x00${occurrence}`;
}

/** Field provenance of one fact value (rule provenance decided per NODE). */
function kindOf(field: NamingField): FieldKind {
  if (INTRINSIC_FIELDS.has(field)) return 'intrinsic';
  if (ASSIGNED_FIELDS.has(field)) return 'assigned';
  return 'derived';
}

/**
 * Fields for which a SAVED rule actually matched THIS node's name — the ONLY
 * way a value earns ai-rule provenance. A rule targeting a field never
 * reclassifies built-in values of that field on other nodes.
 */
function ruleHitsFor(
  name: string,
  rules: { pattern: string; field: 'route' | 'vendor' | 'region' | 'entry' }[],
): Set<string> {
  const hits = new Set<string>();
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, 'i').test(name)) hits.add(rule.field);
    } catch {
      // schema-validated; never reachable at runtime
    }
  }
  return hits;
}

/**
 * Recognize one node and return per-field facts (value + confidence +
 * provenance + ambiguity). Unknown fields are simply absent.
 */
function factsOf(
  proxy: unknown,
  rules: { pattern: string; field: 'route' | 'vendor' | 'region' | 'entry'; value: string }[],
): Array<{
  field: NamingField;
  value: string | null;
  confidence: FactConfidence | null;
  kind: FieldKind;
  ambiguous: boolean;
}> {
  const name =
    typeof (proxy as { name?: unknown }).name === 'string'
      ? ((proxy as { name: string }).name as string)
      : '';
  const type = (proxy as { type?: unknown }).type;
  const out: Array<{
    field: NamingField;
    value: string | null;
    confidence: FactConfidence | null;
    kind: FieldKind;
    ambiguous: boolean;
  }> = [];
  if (name === '') return out;

  // Per-NODE rule provenance: a value is ai-rule ONLY when a saved rule
  // matched THIS node's name for that field; built-in recognition on the same
  // field stays derived (C7).
  const ruleHits = ruleHitsFor(name, rules);
  const recognized = recognizeName(name, rules);
  const push = (
    field: NamingField,
    value: string | null,
    confidence: FactConfidence | null,
    ambiguous: boolean,
  ): void => {
    out.push({
      field,
      value: value === null ? null : sanitizeFragment(value),
      confidence,
      kind: ruleHits.has(field) ? 'ai-rule' : kindOf(field),
      ambiguous,
    });
  };

  push(
    'region',
    recognized.region,
    recognized.confidence.region ?? null,
    recognized.ambiguousFields.includes('region'),
  );
  push(
    'region_code',
    recognized.region,
    recognized.confidence.region ?? null,
    recognized.ambiguousFields.includes('region'),
  );
  push(
    'emoji',
    recognized.region,
    recognized.confidence.region ?? null,
    recognized.ambiguousFields.includes('region'),
  );
  push(
    'rate',
    recognized.rate === null ? null : String(recognized.rate),
    recognized.confidence.rate ?? null,
    false,
  );
  push(
    'route',
    recognized.route,
    recognized.confidence.route ?? null,
    recognized.ambiguousFields.includes('route'),
  );
  push('entry', recognized.entry, recognized.confidence.entry ?? null, false);
  push('vendor', recognized.vendor, recognized.confidence.vendor ?? null, false);
  push(
    'note',
    recognized.base === '' ? null : recognized.base,
    recognized.confidence.note ?? null,
    false,
  );
  if (typeof type === 'string' && type !== '') push('protocol', type, 'high', false);
  const sourceIdentity = sourceOf(proxy);
  if (sourceIdentity) push('source', sourceIdentity.label, 'high', false);
  // index: the upstream ordinal when unambiguous (the value naming renders),
  // else input-order — reported as a bounded fact either way.
  const ordinal = upstreamOrdinalOf(recognized.base);
  push('index', ordinal !== null ? String(ordinal) : 'input-order', 'high', false);

  // Explicit UNKNOWN: every whitelist field is reported per node — absent
  // facts carry a null value/confidence (never a fabricated value).
  const pushed = new Set(out.map((f) => f.field));
  for (const field of NAMING_FIELDS) {
    if (pushed.has(field)) continue;
    out.push({
      field,
      value: null,
      confidence: null,
      kind: kindOf(field),
      ambiguous: false,
    });
  }
  return out;
}

/**
 * Analyze nodes into PER-SOURCE field-coverage reports (a collection's
 * member matrix; a single subscription yields exactly one). `rules` are the
 * saved recognition rules (ai-rule facts).
 */
export function analyzeSourceFacts(
  proxies: readonly unknown[],
  options: {
    sourceOfProxy?: (proxy: unknown) => SourceIdentity | undefined;
    rules?: { pattern: string; field: 'route' | 'vendor' | 'region' | 'entry'; value: string }[];
    sourceKey?: string;
    sourceLabel?: string;
  } = {},
): SourceHealthReport[] {
  const sourceOfProxy = options.sourceOfProxy ?? sourceOf;
  const rules = options.rules ?? [];
  const bySource = new Map<string, { label: string; nodes: unknown[] }>();
  for (const proxy of proxies) {
    const identity = sourceOfProxy(proxy);
    const key = options.sourceKey ?? identity?.key ?? '';
    const label = options.sourceLabel ?? identity?.label ?? key;
    const entry = bySource.get(key) ?? { label, nodes: [] };
    entry.nodes.push(proxy);
    bySource.set(key, entry);
  }
  if (bySource.size === 0) {
    // No provenance: treat everything as one anonymous source.
    bySource.set(options.sourceKey ?? '', {
      label: options.sourceLabel ?? '(未命名)',
      nodes: [...proxies],
    });
  }

  const reports: SourceHealthReport[] = [];
  // Whole-input occurrence map (round-1): node identities use ONE occurrence
  // base over the COMPLETE snapshot — the same base the typed node snapshot
  // scope (namingContextProjection.buildNodeSnapshotScope) uses — so a node
  // repeated across collection members gets occurrence-distinct identities
  // (no cross-source false collision) and every emitted identity round-trips
  // through the snapshot scope.
  const occurrenceByKey = new Map<string, number>();
  for (const [key, { label, nodes }] of bySource) {
    const counts = new Map<
      NamingField,
      Map<string, { count: number; kind: FieldKind; confidence: FactConfidence }>
    >();
    const confidenceCounts = new Map<NamingField, { high: number; medium: number; low: number }>();
    for (const field of NAMING_FIELDS) {
      counts.set(field, new Map());
      confidenceCounts.set(field, { high: 0, medium: 0, low: 0 });
    }
    let ambiguousCount = 0;
    const ambiguousNodes = new Set<string>();
    const nodeFacts: NodeFact[] = [];
    let factsEmitted = 0;
    // TRUE fact-row total across ALL nodes — the semantic unit of
    // nodeFacts (pass-2 finding): a 4-node source with 11 facts per node
    // reports nodeFactsTotal 44, never the node count.
    let factsTotal = 0;

    for (const proxy of nodes) {
      const name =
        typeof (proxy as { name?: unknown }).name === 'string'
          ? ((proxy as { name: string }).name as string)
          : '';
      if (name === '') continue;
      const fp = fingerprintOf(proxy) ?? nodeFingerprint(proxy);
      // round-1: the identity uses the IMMUTABLE envelope rawName when
      // present (a preprocessed/renamed node keeps its upstream identity) —
      // the SAME base the typed node snapshot scope uses, so emitted
      // identities always project through it.
      const rawName = envelopeOf(proxy)?.rawName ?? name;
      const key = `${rawName}\x00${fp ?? ''}`;
      const occurrence = occurrenceByKey.get(key) ?? 0;
      occurrenceByKey.set(key, occurrence + 1);
      const handle = nodeIdentity(rawName, fp, occurrence);
      const facts = factsOf(proxy, rules);
      factsTotal += facts.length;
      let nodeAmbiguous = false;
      for (const fact of facts) {
        const bucket = counts.get(fact.field);
        if (bucket && fact.value !== null && fact.confidence !== null) {
          const meta = bucket.get(fact.value) ?? {
            count: 0,
            kind: fact.kind,
            confidence: fact.confidence,
          };
          meta.count += 1;
          bucket.set(fact.value, meta);
          const dist = confidenceCounts.get(fact.field);
          if (dist) dist[fact.confidence] += 1;
        }
        if (fact.ambiguous) {
          nodeAmbiguous = true;
          ambiguousNodes.add(handle);
        }
      }
      if (nodeAmbiguous) ambiguousCount += 1;
      if (factsEmitted < NODE_FACT_CAP) {
        factsEmitted += 1;
        nodeFacts.push(
          ...facts.map((f) => ({
            node: handle,
            field: f.field,
            value: f.value,
            confidence: f.confidence,
            kind: f.kind,
            ambiguous: f.ambiguous,
          })),
        );
      }
    }

    const total = nodes.length;
    const fields: FieldCoverage[] = NAMING_FIELDS.map((field) => {
      const bucket = counts.get(field) ?? new Map();
      const present = [...bucket.values()].reduce((sum, meta) => sum + meta.count, 0);
      return {
        field,
        present,
        total,
        percent: total === 0 ? 0 : Math.round((present / total) * 100),
        label: FIELD_LABELS[field],
        confidence: confidenceCounts.get(field) ?? { high: 0, medium: 0, low: 0 },
        // Per-VALUE provenance: the bucket's kind was recorded per producing
        // node (rule-matched ⇒ ai-rule, built-in ⇒ derived).
        samples: topSamples(bucket),
        // TRUE distinct-value count + explicit truncation (pass-1 finding).
        sampleTotal: bucket.size,
        sampleTruncated: bucket.size > SAMPLE_CAP,
      };
    });

    const unavailable = fields.filter((f) => f.present === 0).map((f) => f.field);
    const partial = fields.filter((f) => f.present > 0 && f.present < f.total).map((f) => f.field);

    // Drift: scan residuals for near-miss patterns (bounded).
    const drift: DriftReport[] = [];
    for (const { field, re } of DRIFT_PATTERNS) {
      // TRUE count tracked separately from the stored samples (pass-1
      // finding): the loop must never stop counting at the sample cap.
      let count = 0;
      const hits: string[] = [];
      for (const proxy of nodes) {
        const name =
          typeof (proxy as { name?: unknown }).name === 'string'
            ? ((proxy as { name: string }).name as string)
            : '';
        if (name === '') continue;
        const base = recognizeName(name, rules).base;
        if (!re.test(base)) continue;
        count += 1;
        if (hits.length < DRIFT_CAP) {
          const sample = sanitizeFragment(base);
          if (sample !== null) hits.push(sample);
        }
      }
      if (count > 0) {
        drift.push({
          field,
          count,
          samples: hits.slice(0, SAMPLE_CAP),
          samplesTruncated: count > SAMPLE_CAP,
        });
      }
    }

    reports.push({
      sourceKey: key,
      sourceLabel: sanitizeFragment(label) ?? '(未命名)',
      nodeCount: nodes.length,
      fields,
      nodeFacts,
      // TRUE semantic totals in FACT ROWS — the stored view is capped, but
      // the totals always carry the full fact count (pass-2 finding).
      nodeFactsTotal: factsTotal,
      nodeFactsTruncated: factsTotal > nodeFacts.length,
      unavailable,
      partial,
      ambiguousCount,
      drift,
    });
  }

  return reports;
}
