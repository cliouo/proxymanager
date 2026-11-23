/**
 * Read-only, credential-redacting access to the whole base.yaml for the
 * assistant (Tier D phase 1). Lets the AI see the full config structure and
 * drill into any section without ever seeing node secrets.
 *
 * Two views, two strategies:
 *   - get_config_full → `fullRedactedYaml`: structure-faithful. Redaction edits
 *     sensitive values in place on the parsed Document, so anchors (&x),
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

import {
  isAlias, isNode, isPair, isScalar, parseDocument, Scalar, stringify, visit,
  type Document, type Node, type Pair,
} from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { parsePath, SENSITIVE_KEY } from './configPath';

export const REDACTED = '***';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ─── structure-faithful redaction (full view) ──────────────────────── */

function pairKey(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : '';
}

function isProxyBlock(key: string): boolean {
  return key === 'proxies' || key === 'proxy-providers';
}

const PROXY_CONNECTION_KEY =
  /^(?:server|servername|serverport|serverports|port|ports|sni|peer|host|hostname|address|ip|uid|userid|user|username|clientid|apikey|accesskey|publickey|shortid|header|headers|path|query|params|urlparams)$/i;

function proxyPairs(doc: Document): Set<Pair> {
  const pairs = new Set<Pair>();
  const visited = new Set<Node>();
  const mark = (root: Node) => visit(root, {
    Node(_, node) {
      if (visited.has(node)) return visit.SKIP;
      visited.add(node);
      if (isAlias(node)) {
        const target = node.resolve(doc);
        if (target) mark(target);
      }
    },
    Pair(_, pair) {
      pairs.add(pair);
    },
  });
  visit(doc, {
    Pair(_, pair) {
      if (isProxyBlock(pairKey(pair)) && isNode(pair.value)) mark(pair.value);
    },
  });
  return pairs;
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
      /\b(token|secret|password|passwd|uuid|psk|key|credential|auth|server|port|sni|server[-_]?name|uid)\s*[=:]\s*\S+/gi,
      `$1=${REDACTED}`,
    );
}

interface Commentable {
  comment?: string | null;
  commentBefore?: string | null;
}

/**
 * Mask sensitive values at their definitions, including values reached through
 * aliases, so neither the anchor definition nor a section drill-down leaks.
 */
export function redactDocument(doc: Document, maskInheritedHealthCheckUrls = false): boolean {
  const scoped = proxyPairs(doc);
  const masked = new Set<Node>();
  const names = new Set<Node>();
  visit(doc, {
    Pair(_, pair, path) {
      if (!isNode(pair.value)) return;
      const key = pairKey(pair);
      const value = isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      if (!value) return;
      if (scoped.has(pair) && key === 'name') names.add(value);
      const proxyUrl = key === 'url' && (
        path.some((ancestor) => isPair(ancestor) && isProxyBlock(pairKey(ancestor))) ||
        (scoped.has(pair) && (maskInheritedHealthCheckUrls ||
          !path.some((ancestor) => isPair(ancestor) && pairKey(ancestor) === 'health-check')))
      );
      if (
        SENSITIVE_KEY.test(key) ||
        proxyUrl ||
        (scoped.has(pair) && PROXY_CONNECTION_KEY.test(key.replace(/[-_]/g, '')))
      ) {
        masked.add(value);
      }
    },
  });
  for (const value of masked) {
    visit(value, {
      Alias(_, alias) {
        const target = alias.resolve(doc);
        if (target) masked.add(target);
      },
    });
  }

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
    Node(_, n) {
      scrub(n);
      if (masked.has(n)) {
        if (isScalar(n)) {
          if (n.value !== REDACTED) changed = true;
          n.value = REDACTED;
        } else {
          changed = true;
          const replacement = new Scalar(REDACTED);
          replacement.anchor = n.anchor;
          return replacement;
        }
      } else if (isScalar(n) && !names.has(n) && typeof n.value === 'string' && n.value.includes('://')) {
        const safeUrl = scrubUrlTokens(n.value);
        if (safeUrl !== n.value) {
          n.value = safeUrl;
          changed = true;
        }
      }
    },
  });
  scrub(doc as Commentable);
  return changed;
}

/** The whole base.yaml as redacted YAML — for holistic review (get_config_full). */
export function fullRedactedYaml(content: string): string {
  const doc = parseConfig(content);
  redactDocument(doc);
  return doc.toString().trimEnd();
}

/* ─── effective-config redaction (outline / section) ────────────────── */

function parseConfig(content: string, merge = false): Document {
  const doc = parseDocument(content, { merge });
  if (doc.errors.length > 0) {
    throw ProblemDetailsError.unprocessable('base.yaml 解析失败。');
  }
  return doc;
}

function effectiveConfig(doc: Document): Obj {
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
  const doc = parseConfig(content, true);
  redactDocument(doc);
  const root = effectiveConfig(doc);
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
  const doc = parseConfig(content, true);
  const segs = parsePath(path);
  const value = navigate(effectiveConfig(doc), segs);
  if (value === undefined) return { found: false };
  const projected = redactDocument(doc, true) ? navigate(effectiveConfig(doc), segs) : value;
  const red = projected === undefined ? REDACTED : projected;
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
