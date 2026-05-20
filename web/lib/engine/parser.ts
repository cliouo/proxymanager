import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

export interface ParsedBase {
  anchors: string[];
  policies: string[];
  proxyProviders: string[];
  ruleProviders: string[];
}

const ANCHOR_PATTERN = /===\s*ANCHOR:\s*([\w-]+)\s*===/g;

/**
 * Mihomo/Clash built-in policy keywords. A rule may target any of these
 * directly without a matching proxy-group or proxies entry.
 */
const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];

export class BaseParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BaseParseError';
  }
}

export function parseBase(content: string): ParsedBase {
  const anchors = extractAnchors(content);

  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw new BaseParseError(`Invalid YAML: ${doc.errors[0].message}`, doc.errors);
  }

  return {
    anchors,
    policies: extractPolicies(doc),
    proxyProviders: extractMapKeys(doc.get('proxy-providers', true)),
    ruleProviders: extractMapKeys(doc.get('rule-providers', true)),
  };
}

function extractAnchors(content: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of content.matchAll(ANCHOR_PATTERN)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

/**
 * A rule's policy can target any of:
 *   - a proxy-group name
 *   - a standalone proxy node name (`proxies[].name`, e.g. `type: direct` aliases)
 *   - a Mihomo built-in (DIRECT, REJECT, …)
 * Order: proxy-groups first (most common), then proxies, then built-ins.
 */
function extractPolicies(doc: ReturnType<typeof parseDocument>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const name of collectNamesFromSeq(doc.get('proxy-groups', true))) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  for (const name of collectNamesFromSeq(doc.get('proxies', true))) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  for (const name of BUILTIN_POLICIES) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }

  return out;
}

function collectNamesFromSeq(node: unknown): string[] {
  if (!isSeq(node)) return [];
  const names: string[] = [];
  for (const item of node.items) {
    if (!isMap(item)) continue;
    const nameNode = item.get('name', true);
    if (isScalar(nameNode) && typeof nameNode.value === 'string') {
      names.push(nameNode.value);
    }
  }
  return names;
}

function extractMapKeys(node: unknown): string[] {
  if (!isMap(node)) return [];
  const out: string[] = [];
  for (const pair of node.items) {
    if (isScalar(pair.key) && typeof pair.key.value === 'string') {
      out.push(pair.key.value);
    }
  }
  return out;
}
