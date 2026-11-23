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

import { domainToASCII } from 'node:url';
import {
  isAlias, isMap, isNode, isPair, isScalar, isSeq, parseDocument, Scalar, stringify, visit,
  type Document, type Node, type Pair, type YAMLMap,
} from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { parseAndValidateFinalRule } from '@/lib/engine/resolve';
import { getBase } from '@/lib/repos/baseRepo';
import { maskProxyEndpoint } from '@/lib/proxies/namingSanitize';
import { parsePath, SENSITIVE_KEY } from './configPath';

export const REDACTED = '***';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ─── structure-faithful redaction (full view) ──────────────────────── */

function pairKey(doc: Document, pair: Pair): string {
  const key = isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
  if (!isScalar(key)) return '';
  return typeof key.value === 'symbol' && key.value.description === '<<' ? '<<' : String(key.value);
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
      if (isProxyBlock(pairKey(doc, pair)) && isNode(pair.value)) mark(pair.value);
    },
  });
  return pairs;
}

function normalizeEndpointHost(host: string): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return domainToASCII(bracketed).replace(/\.$/u, '');
}

const ENDPOINT_IN_NAME =
  /\[[\da-f:.]+\](?::\d+)?|[\da-f]*:[\da-f:.]*:(?:[\da-f:.]*[\da-f:])?|[\p{L}\p{M}\p{N}_-]+(?:[.。．｡][\p{L}\p{M}\p{N}_-]+)*[.。．｡]?(?::\d+)?/giu;

function maskNormalizedEndpoint(name: string, server: unknown, port: unknown): string {
  if (typeof server !== 'string') return name;
  const normalized = normalizeEndpointHost(server.trim());
  const portText = String(port ?? '');
  const projected = normalized ? name.replace(ENDPOINT_IN_NAME, (candidate) => {
    if (normalizeEndpointHost(candidate) === normalized) return REDACTED;
    const split = /^(.*):(\d+)$/u.exec(candidate);
    if (!split || normalizeEndpointHost(split[1]) !== normalized) return candidate;
    return split[2] === portText ? REDACTED : `${REDACTED}:${split[2]}`;
  }) : name;
  return maskProxyEndpoint(projected, { server, port });
}

function proxyNameProjection(doc: Document, scoped: Set<Pair>) {
  const resolve = (node: unknown) => isAlias(node) ? node.resolve(doc) : node;
  function property(map: YAMLMap, key: string, seen = new Set<YAMLMap>()): unknown {
    if (seen.has(map)) return undefined;
    seen.add(map);
    const own = map.items.find((pair) => pairKey(doc, pair) === key);
    if (own) return resolve(own.value);
    const merge = resolve(map.items.find((pair) => pairKey(doc, pair) === '<<')?.value);
    for (const entry of isSeq(merge) ? merge.items : [merge]) {
      const source = resolve(entry);
      const value = isMap(source) ? property(source, key, seen) : undefined;
      if (value !== undefined) return value;
    }
    return undefined;
  }

  const definitions = new Map<Node, string>();
  const names = new Map<string, string>();
  const groupNames = new Set<string>();
  const reserved = new Set<string>();
  visit(doc, {
    Pair(_, pair) {
      if (pairKey(doc, pair) !== 'proxy-groups') return;
      const groups = resolve(pair.value);
      if (!isSeq(groups)) return;
      for (const item of groups.items) {
        const group = resolve(item);
        const name = isMap(group) ? property(group, 'name') : undefined;
        if (!isScalar(name) || typeof name.value !== 'string') continue;
        groupNames.add(name.value);
        definitions.set(name, name.value);
        if (!names.has(name.value)) names.set(name.value, scrubUrlTokens(name.value));
      }
    },
    Map(_, map) {
      const name = property(map, 'name');
      if (!isScalar(name) || typeof name.value !== 'string') return;
      reserved.add(name.value);
      if (!map.items.some((pair) => scoped.has(pair))) return;
      definitions.set(name, name.value);
      const server = property(map, 'server');
      const port = property(map, 'port');
      names.set(name.value, maskNormalizedEndpoint(
        names.get(name.value) ?? scrubUrlTokens(name.value),
        isScalar(server) ? server.value : undefined,
        isScalar(port) ? port.value : undefined,
      ));
    },
  });
  for (const original of new Set([...groupNames, ...names.keys()])) {
    const masked = names.get(original) ?? original;
    if (original === masked) continue;
    let name = masked;
    for (let suffix = 2; reserved.has(name); suffix += 1) name = `${masked} #${suffix}`;
    reserved.add(name);
    names.set(original, name);
  }
  const values = new Map<Node, string>();
  for (const [node, name] of definitions) values.set(node, names.get(name) ?? name);

  const project = (node: unknown, rule = false) => {
    const value = resolve(node);
    if (!isScalar(value) || typeof value.value !== 'string') return;
    const name = rule ? projectRulePolicy(value.value, names) : names.get(value.value);
    if (name !== undefined) values.set(value, name);
  };
  const projectList = (node: unknown, rule = false) => {
    const seq = resolve(node);
    if (isSeq(seq)) for (const item of seq.items) project(item, rule);
  };
  visit(doc, {
    Pair(_, pair) {
      switch (pairKey(doc, pair)) {
        case 'dialer-proxy':
        case 'empty-fallback': project(pair.value); break;
        case 'proxies': projectList(pair.value); break;
        case 'rules': projectList(pair.value, true); break;
        case 'sub-rules': {
          const map = resolve(pair.value);
          if (isMap(map)) for (const entry of map.items) projectList(entry.value, true);
          break;
        }
      }
    },
  });
  return { values, names };
}

function projectRulePolicy(raw: string, names: ReadonlyMap<string, string>): string | undefined {
  try {
    const { type, target, params } = parseAndValidateFinalRule(raw);
    const projected = names.get(target);
    if (type === 'SUB-RULE' || projected === undefined) return undefined;
    const parts = raw.split(',');
    const i = parts.length - 1 - params.length;
    const field = parts[i];
    for (let j = 0; j < parts.length; j += 1) {
      parts[j] = j === i ? field.replace(target, () => projected) : scrubUrlTokens(parts[j]);
    }
    return parts.join(',');
  } catch {
    return undefined;
  }
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
function redactDocument(doc: Document, maskInheritedHealthCheckUrls = false) {
  const scoped = proxyPairs(doc);
  const { values: proxyNames, names: projectedNames } = proxyNameProjection(doc, scoped);
  const masked = new Set<Node>();
  const names = new Set<Node>();
  visit(doc, {
    Pair(_, pair, path) {
      if (!isNode(pair.value)) return;
      const key = pairKey(doc, pair);
      const value = isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      if (!value) return;
      if (scoped.has(pair) && key === 'name') names.add(value);
      const proxyUrl = key === 'url' && (
        path.some((ancestor) => isPair(ancestor) && isProxyBlock(pairKey(doc, ancestor))) ||
        (scoped.has(pair) && (maskInheritedHealthCheckUrls ||
          !path.some((ancestor) => isPair(ancestor) && pairKey(doc, ancestor) === 'health-check')))
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

  const removedAnchors = new Set<Node>();
  for (const value of masked) {
    if (isScalar(value)) continue;
    visit(value, {
      Node(_, node) {
        if (node !== value && node.anchor) removedAnchors.add(node);
      },
    });
  }
  const orphanedAliases = new Set<Node>();
  const maskedMerges = new Set<Node>();
  visit(doc, {
    Alias(_, alias, path) {
      const target = alias.resolve(doc);
      if (!target) return;
      if (removedAnchors.has(target)) orphanedAliases.add(alias);
      const parent = path.at(-1);
      const pair = isSeq(parent) ? path.at(-2) : parent;
      if (
        !isScalar(target) &&
        (removedAnchors.has(target) || masked.has(target)) &&
        isPair(pair) && pairKey(doc, pair) === '<<' && pair.value === (isSeq(parent) ? parent : alias)
      ) {
        maskedMerges.add(alias);
      }
    },
  });

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
      if (maskedMerges.has(n) || orphanedAliases.has(n)) {
        changed = true;
        return maskedMerges.has(n) ? doc.createNode({}) : new Scalar(REDACTED);
      }
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
      } else if (isScalar(n) && typeof n.value === 'string') {
        const projected = proxyNames.get(n) ??
          (names.has(n) ? n.value : scrubUrlTokens(n.value));
        if (projected !== n.value) {
          n.value = projected;
          changed = true;
        }
      }
    },
  });
  scrub(doc as Commentable);
  return { changed, projectedNames };
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

function navigate(
  root: Obj,
  segs: ReturnType<typeof parsePath>,
  selectorRoot: Obj,
  projectedNames: ReadonlyMap<string, string>,
): unknown {
  let cur: unknown = root;
  let original: unknown = selectorRoot;
  for (const s of segs) {
    if (!isObj(cur) || !isObj(original)) return undefined;
    cur = cur[s.key];
    original = original[s.key];
    if (s.selector !== undefined) {
      if (!Array.isArray(cur) || !Array.isArray(original)) return undefined;
      const index = original.findIndex((it) => isObj(it) &&
        (it.name === s.selector ||
          ((s.key === 'proxies' || s.key === 'proxy-groups') &&
            typeof it.name === 'string' && projectedNames.get(it.name) === s.selector)));
      cur = cur[index];
      original = original[index];
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
  const original = effectiveConfig(doc);
  const { changed, projectedNames } = redactDocument(doc, true);
  const value = navigate(original, segs, original, projectedNames);
  if (value === undefined) return { found: false };
  const projected = changed ? navigate(effectiveConfig(doc), segs, original, projectedNames) : value;
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
