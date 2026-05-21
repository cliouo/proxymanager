/**
 * Expand `pm-inline-collections` in base.yaml at render time.
 *
 * Looks for a top-level field:
 *
 *     pm-inline-collections:
 *       - main-pool
 *       - backup-pool
 *
 * For each named collection, resolves its subscriptions (explicit ids +
 * tags), fetches their content through `resolveSubscriptionContent` (which
 * is cache-aware), parses the proxies, merges them with the configured
 * dedup + name-prefix policy, and appends them to the `proxies:` block.
 * Removes the `pm-inline-collections` field from the document on the way
 * out so the final config is pure Mihomo.
 *
 * The Document API preserves comments, key order, and unknown fields, so
 * everything else in base.yaml passes through unchanged.
 */

import { parse as parseYaml, parseDocument, isMap, isSeq, isScalar, type YAMLSeq, type YAMLMap } from 'yaml';
import { getCollectionByName, listCollections } from '@/lib/repos/collectionsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import type { Collection, Subscription } from '@/schemas';

const FIELD = 'pm-inline-collections';

export interface SubResolution {
  name: string;
  proxyCount: number;
  /** Set if the sub failed to fetch — its proxies were skipped. */
  error?: string;
}

export interface CollectionResolution {
  name: string;
  subs: SubResolution[];
  totalAfterDedup: number;
  warnings: string[];
}

export interface ExpansionSummary {
  collections: CollectionResolution[];
  inlinedProxyCount: number;
  /** Total number of proxies left after merge + dedup, across all collections. */
  errors: string[];
}

export interface ExpandOptions {
  /** When true, sub fetch failures are logged but don't abort the render. */
  ignoreFailedSubs?: boolean;
  /** When true, force-refresh upstream (bypass fetch cache). */
  noCache?: boolean;
}

export interface ExpandResult {
  expandedContent: string;
  summary: ExpansionSummary;
}

/**
 * Public entry. Returns the new YAML content (with proxies inlined +
 * `pm-inline-collections` removed) plus a summary the API can log/expose.
 */
export async function expandCollections(
  content: string,
  opts: ExpandOptions = {},
): Promise<ExpandResult> {
  const doc = parseDocument(content);
  const summary: ExpansionSummary = {
    collections: [],
    inlinedProxyCount: 0,
    errors: [],
  };

  const collectionNames = readCollectionNames(doc);
  if (collectionNames.length === 0) {
    return { expandedContent: content, summary };
  }

  const allSubs = await listSubscriptions();
  const subsByName = new Map(allSubs.map((s) => [s.name, s]));
  const allCols = await listCollections();
  const colByName = new Map(allCols.map((c) => [c.name, c]));

  // Existing proxy names in base.yaml — used to detect collisions before we
  // start splicing.
  const baseProxyNames = readBaseProxyNames(doc);
  const seenAcrossCollections = new Set<string>(baseProxyNames);

  for (const colName of collectionNames) {
    const col = colByName.get(colName);
    if (!col) {
      const msg = `Collection "${colName}" not found.`;
      summary.errors.push(msg);
      if (opts.ignoreFailedSubs) continue;
      throw new Error(msg);
    }

    const resolution: CollectionResolution = {
      name: colName,
      subs: [],
      totalAfterDedup: 0,
      warnings: [],
    };

    const subsForCol = resolveCollectionSubs(col, allSubs);

    // Pull each sub's proxies, normalised to a JS array.
    const allProxies: unknown[] = [];
    for (const sub of subsForCol) {
      try {
        if (!sub.enabled) {
          resolution.subs.push({ name: sub.name, proxyCount: 0, error: 'disabled' });
          continue;
        }
        const { yaml: subYaml, proxyCount } = await resolveSubscriptionContent(sub, {
          noCache: opts.noCache,
        });
        const parsed = parseYaml(subYaml) as { proxies?: unknown };
        if (Array.isArray(parsed?.proxies)) {
          allProxies.push(...parsed.proxies);
        }
        resolution.subs.push({ name: sub.name, proxyCount });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolution.subs.push({ name: sub.name, proxyCount: 0, error: msg });
        if (!opts.ignoreFailedSubs) throw err;
      }
    }

    // Dedup + prefix. Dedup operates on the upstream identity (pre-prefix)
    // so two subs offering the same node still collapse to one.
    const deduped = dedupProxies(allProxies, col.dedup_by);
    const prefixed = applyNamePrefix(deduped, col.name_prefix);

    // Reject cross-collection / base collisions.
    for (const p of prefixed) {
      const name = readProxyName(p);
      if (name && seenAcrossCollections.has(name)) {
        resolution.warnings.push(
          `Proxy "${name}" already present from base or earlier collection; skipping.`,
        );
        // Skip — drop the colliding one.
        continue;
      }
      if (name) seenAcrossCollections.add(name);
      appendProxy(doc, p);
      resolution.totalAfterDedup += 1;
    }

    summary.collections.push(resolution);
    summary.inlinedProxyCount += resolution.totalAfterDedup;
  }

  // Strip the field — Mihomo will reject unknown top-level keys for some
  // distributions; better safe than sorry.
  doc.delete(FIELD);

  return { expandedContent: doc.toString(), summary };
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

function readCollectionNames(doc: ReturnType<typeof parseDocument>): string[] {
  const node = doc.get(FIELD, true);
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === 'string') out.push(item.value);
  }
  return out;
}

function readBaseProxyNames(doc: ReturnType<typeof parseDocument>): string[] {
  const node = doc.get('proxies', true);
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (isMap(item)) {
      const nameNode = (item as YAMLMap).get('name', true);
      if (isScalar(nameNode) && typeof nameNode.value === 'string') {
        out.push(nameNode.value);
      }
    }
  }
  return out;
}

function appendProxy(doc: ReturnType<typeof parseDocument>, proxy: unknown): void {
  let node = doc.get('proxies', true);
  if (!isSeq(node)) {
    // Create the section if missing.
    doc.set('proxies', []);
    node = doc.get('proxies', true);
  }
  (node as YAMLSeq).add(proxy);
}

function resolveCollectionSubs(col: Collection, allSubs: Subscription[]): Subscription[] {
  const subsById = new Map(allSubs.map((s) => [s.id, s]));
  const out: Subscription[] = [];
  const seen = new Set<string>();
  for (const id of col.subscription_ids) {
    const s = subsById.get(id);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  if (col.subscription_tags.length > 0) {
    for (const s of allSubs) {
      if (!seen.has(s.id) && s.tags.some((t) => col.subscription_tags.includes(t))) {
        seen.add(s.id);
        out.push(s);
      }
    }
  }
  return out;
}

function dedupProxies(proxies: unknown[], mode: Collection['dedup_by']): unknown[] {
  if (mode === 'none') return proxies;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const p of proxies) {
    const key = mode === 'name' ? readProxyName(p) : readServerPortKey(p);
    if (!key) {
      // Can't compute a key — keep it (don't risk over-dedup).
      out.push(p);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function applyNamePrefix(proxies: unknown[], prefix?: string): unknown[] {
  if (!prefix) return proxies;
  return proxies.map((p) => {
    if (p && typeof p === 'object') {
      const orig = (p as { name?: unknown }).name;
      if (typeof orig === 'string') {
        return { ...(p as object), name: `${prefix}${orig}` };
      }
    }
    return p;
  });
}

function readProxyName(p: unknown): string | undefined {
  if (p && typeof p === 'object') {
    const name = (p as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function readServerPortKey(p: unknown): string | undefined {
  if (p && typeof p === 'object') {
    const obj = p as { server?: unknown; port?: unknown };
    if (typeof obj.server === 'string' && (typeof obj.port === 'number' || typeof obj.port === 'string')) {
      return `${obj.server}:${obj.port}`;
    }
  }
  return undefined;
}
