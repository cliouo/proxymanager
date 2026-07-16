/**
 * Read-only, credential-redacting access to the whole base.yaml for the
 * assistant (Tier D phase 1). Lets the AI see the full config structure and
 * drill into any section without ever seeing node secrets.
 *
 * Two views, two strategies:
 *   - get_config_full → `fullRedactedYaml`: structure-faithful. Redaction edits
 *     sensitive scalar VALUES in place on the parsed Document, so anchors (&x),
 *     aliases (*x), merge keys (<<:), comments and flow style all survive
 *     `doc.toString()`. (The old code went through `doc.toJS()`, which resolves
 *     aliases into inline copies and drops anchors — making the model
 *     hallucinate "missing &" / "empty <<" bugs.)
 *   - outline / section → effective config: parsed with `merge: true` so each
 *     section shows its resolved values (a self-contained drill-down can't keep
 *     an alias whose anchor lives elsewhere without tripping serialisation).
 *
 * Writes are NOT here — they go through the path-scoped, confirm-gated
 * config-section scenario.
 */

import { isPair, isScalar, parseDocument, stringify, visit, type Document } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { parsePath, SENSITIVE_KEY } from './configPath';

export const REDACTED = '***';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ─── structure-faithful redaction (full view) ──────────────────────── */

/** A `url` is a credential only under node/subscription sources, not elsewhere. */
function inSecretUrlScope(path: readonly unknown[]): boolean {
  for (const n of path) {
    if (isPair(n) && isScalar(n.key)) {
      const k = n.key.value;
      if (k === 'proxies' || k === 'proxy-providers') return true;
    }
  }
  return false;
}

// There is no reliable way to distinguish a public path/query value from a
// short bearer token. Assistant-facing views therefore keep only URL origins;
// every path/query/fragment is replaced instead of guessed from its shape.
const URL_RE = /https?:\/\/[^\s"'<>]+/giu;

export function scrubUrlTokens(s: string): string {
  return s.replace(URL_RE, (raw) => {
    const trailing = raw.match(/[),.;\]}]+$/u)?.[0] ?? '';
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    try {
      const parsed = new URL(candidate);
      const hasHiddenPart =
        parsed.username !== '' ||
        parsed.password !== '' ||
        (parsed.pathname !== '' && parsed.pathname !== '/') ||
        parsed.search !== '' ||
        parsed.hash !== '';
      return `${parsed.protocol}//${parsed.host}${hasHiddenPart ? `/${REDACTED}` : ''}${trailing}`;
    } catch {
      return `${REDACTED}${trailing}`;
    }
  });
}

/**
 * Comments survive the faithful round-trip, and the user's commented-out
 * subscriptions carry full URLs/tokens. Scrub those so they never reach the
 * model: mask any URL and obvious token/secret assignments in free text.
 */
function scrubComment(c: string | null | undefined): string | null | undefined {
  if (!c) return c;
  return c
    .replace(/https?:\/\/\S+/gi, REDACTED)
    .replace(
      /\b(token|secret|password|passwd|uuid|psk|key|credential|auth)\s*[=:]\s*\S+/gi,
      `$1=${REDACTED}`,
    );
}

interface Commentable {
  comment?: string | null;
  commentBefore?: string | null;
}

/**
 * Mask credential scalars in place on a parsed Document, and scrub secrets out
 * of comments. Only scalar values + comment strings are touched, so anchors,
 * aliases, merge keys and structure are preserved on round-trip.
 */
export function redactDocument(doc: Document): boolean {
  let changed = false;
  const scrub = (n: Commentable) => {
    const before = scrubComment(n.commentBefore);
    if (before !== n.commentBefore) {
      n.commentBefore = before;
      changed = true;
    }
    const inline = scrubComment(n.comment);
    if (inline !== n.comment) {
      n.comment = inline;
      changed = true;
    }
  };
  visit(doc, {
    Map: (_, n) => scrub(n),
    Seq: (_, n) => scrub(n),
    Scalar(_, n) {
      scrub(n);
      // Mask token-like segments in any URL value (e.g. self-hosted rule-set
      // URLs on a tokenised host). Fully-masked scalars no longer contain '://'.
      if (typeof n.value === 'string' && n.value.includes('://')) {
        const masked = scrubUrlTokens(n.value);
        if (masked !== n.value) {
          n.value = masked;
          changed = true;
        }
      }
    },
    Pair(_, pair, path) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      const sensitive = SENSITIVE_KEY.test(key) || (key === 'url' && inSecretUrlScope(path));
      if (sensitive && isScalar(pair.value) && pair.value.value !== REDACTED) {
        pair.value.value = REDACTED;
        changed = true;
      }
    },
  });
  scrub(doc as Commentable);
  return changed;
}

/** The whole base.yaml as redacted YAML — for holistic review (get_config_full). */
export function fullRedactedYaml(content: string): string {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw ProblemDetailsError.unprocessable(`base.yaml 解析失败：${doc.errors[0].message}`);
  }
  redactDocument(doc);
  return doc.toString().trimEnd();
}

/* ─── effective-config redaction (outline / section) ────────────────── */

/** Recursively mask credentials on a plain (merge-resolved) object. */
function redact(value: unknown, inProxyProviders = false): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, inProxyProviders));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k) || (inProxyProviders && k === 'url')) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, inProxyProviders);
      }
    }
    return out;
  }
  // Mask token-like segments in any URL string (e.g. self-hosted rule-set URLs).
  if (typeof value === 'string' && value.includes('://')) return scrubUrlTokens(value);
  return value;
}

/** base.yaml as a merge-resolved plain object (effective config). */
function effectiveConfig(content: string): Obj {
  const doc = parseDocument(content, { merge: true });
  if (doc.errors.length > 0) {
    throw ProblemDetailsError.unprocessable(`base.yaml 解析失败：${doc.errors[0].message}`);
  }
  const js = doc.toJS();
  return isObj(js) ? js : {};
}

export type OutlineEntry =
  | { key: string; kind: 'scalar'; value: unknown }
  | { key: string; kind: 'map'; children: string[] }
  | { key: string; kind: 'list-named'; count: number; names: string[] }
  | { key: string; kind: 'list'; count: number };

/** A redacted table-of-contents: top-level blocks + their child keys/names. */
export function buildOutline(content: string): OutlineEntry[] {
  const root = effectiveConfig(content);
  const entries: OutlineEntry[] = [];
  for (const [key, val] of Object.entries(root)) {
    if (Array.isArray(val)) {
      const named = val
        .filter((x): x is Obj => isObj(x) && typeof x.name === 'string')
        .map((x) => x.name as string);
      if (val.length > 0 && named.length === val.length) {
        entries.push({ key, kind: 'list-named', count: val.length, names: named.slice(0, 60) });
      } else {
        entries.push({ key, kind: 'list', count: val.length });
      }
    } else if (isObj(val)) {
      entries.push({ key, kind: 'map', children: Object.keys(val) });
    } else {
      entries.push({ key, kind: 'scalar', value: SENSITIVE_KEY.test(key) ? REDACTED : val });
    }
  }
  return entries;
}

function navigate(root: Obj, segs: ReturnType<typeof parsePath>): unknown {
  let cur: unknown = root;
  for (const s of segs) {
    if (!isObj(cur)) return undefined;
    cur = cur[s.key];
    if (s.selector !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find((it) => isObj(it) && it.name === s.selector);
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

export interface SectionResult {
  found: boolean;
  /** Redacted value serialised to YAML (scalars stringified plainly). */
  yaml?: string;
  /** True when redaction masked something in this subtree. */
  redacted?: boolean;
}

export function getConfigSection(content: string, path: string): SectionResult {
  const root = effectiveConfig(content);
  const segs = parsePath(path);
  const value = navigate(root, segs);
  if (value === undefined) return { found: false };
  const inProxyProviders = segs[0]?.key === 'proxy-providers';
  const lastKey = segs[segs.length - 1].key;
  let red = redact(value, inProxyProviders);
  // Scalar leaves carry no key context inside `redact`; mask here when the
  // path itself points at a credential (e.g. `secret`, `proxies[x].password`).
  if (!isObj(red) && !Array.isArray(red)) {
    if (SENSITIVE_KEY.test(lastKey) || (inProxyProviders && lastKey === 'url')) red = REDACTED;
  }
  const redacted = JSON.stringify(red) !== JSON.stringify(value);
  const yaml = isObj(red) || Array.isArray(red) ? stringify(red).trimEnd() : String(red);
  return { found: true, yaml, redacted };
}

/** Load base.yaml raw text (structure intact — do NOT toJS, it drops anchors). */
export async function loadBaseContent(profileId: string): Promise<string> {
  const base = await getBase(profileId);
  if (!base) {
    throw ProblemDetailsError.unprocessable('base.yaml 尚未初始化。');
  }
  return base.content;
}
