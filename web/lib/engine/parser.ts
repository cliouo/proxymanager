import { isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import { validateMihomoProxyList } from '@/lib/proxies/mihomoProxyValidator';

export interface ParsedBase {
  anchors: string[];
  policies: string[];
  proxyProviders: string[];
  ruleProviders: string[];
}

// Must match the renderer's ANCHOR_LINE_PATTERN exactly: an anchor is only
// injectable when its `# === ANCHOR: name ===` comment occupies its own line.
// A looser whole-text match (P3-11) would advertise anchors the renderer never
// injects at → rules targeting them pass validation but silently never render.
const ANCHOR_PATTERN = /^[ \t]*#\s*===\s*ANCHOR:\s*([\w-]+)\s*===[ \t]*$/gm;

/**
 * Mihomo/Clash built-in policy keywords. A rule may target any of these
 * directly without a matching proxy-group or proxies entry.
 */
const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];
const INVALID_BASE_YAML_MESSAGE = 'Invalid base YAML';
const INVALID_BASE_ROOT_MESSAGE = 'Invalid base YAML: root must be a mapping';
const INVALID_BASE_MERGE_MESSAGE = 'Invalid base YAML: merge keys are not supported';
const SEQUENCE_SECTIONS = ['proxies', 'proxy-groups', 'rules'] as const;
const MAPPING_SECTIONS = ['proxy-providers', 'rule-providers'] as const;

export class BaseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseParseError';
  }
}

/**
 * Parse a base skeleton without exposing yaml's source excerpts in errors.
 * Every engine consumer requires a top-level mapping because it reads and
 * mutates named Mihomo sections (`proxies`, `rules`, ...).
 */
export function parseBaseDocument(content: string): ReturnType<typeof parseDocument> {
  try {
    const doc = parseDocument(content);
    if (doc.errors.length > 0) {
      throw new BaseParseError(INVALID_BASE_YAML_MESSAGE);
    }
    if (!isMap(doc.contents)) {
      throw new BaseParseError(INVALID_BASE_ROOT_MESSAGE);
    }
    assertNoMergeKeys(doc);
    assertKnownSectionShapes(doc);
    return doc;
  } catch (err) {
    if (err instanceof BaseParseError) throw err;
    throw new BaseParseError(INVALID_BASE_YAML_MESSAGE);
  }
}

/**
 * Fixed Mihomo's Go YAML loader expands `<<` merges, while the JS YAML AST and
 * mutation pipeline intentionally do not. Reject the construct at the common
 * boundary so inherited proxies, rules, or contextual rule-set references can
 * never become invisible to validation.
 */
function assertNoMergeKeys(doc: ReturnType<typeof parseDocument>): void {
  let found = false;
  visit(doc, {
    Pair(_key, pair) {
      if (
        isScalar(pair.key) &&
        ((pair.key.value === '<<' &&
          ((pair.key.tag === undefined && pair.key.type === 'PLAIN') || pair.key.tag === '!')) ||
          pair.key.tag === 'tag:yaml.org,2002:merge')
      ) {
        found = true;
        return visit.BREAK;
      }
    },
  });
  if (found) throw new BaseParseError(INVALID_BASE_MERGE_MESSAGE);
}

function assertKnownSectionShapes(doc: ReturnType<typeof parseDocument>): void {
  for (const key of SEQUENCE_SECTIONS) {
    const section = doc.get(key, true);
    if (section !== undefined && !isSeq(section)) {
      throw new BaseParseError(`Invalid base YAML: "${key}" must be a sequence`);
    }
    if (key === 'proxies' && isSeq(section)) {
      try {
        validateMihomoProxyList(section.toJSON() as unknown[], {
          allowExternalDialerProxy: true,
          allowLocalFileReferences: true,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid proxy entry';
        throw new BaseParseError(`Invalid base YAML: ${detail}`);
      }
    }
  }
  for (const key of MAPPING_SECTIONS) {
    const section = doc.get(key, true);
    if (section !== undefined && !isMap(section)) {
      throw new BaseParseError(`Invalid base YAML: "${key}" must be a mapping`);
    }
  }
}

export function parseBase(content: string): ParsedBase {
  const anchors = extractAnchors(content);
  const doc = parseBaseDocument(content);

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

/**
 * 合并"规则 policy 的合法目标全集"：托管策略组（hash，调用方按 rank 序传入）
 * 优先，其后是 base 字面 policies（骨架里残留的组 / 手写节点 / 内建）。
 * 策略组已迁出 base.yaml（只剩 # === PROXY-GROUPS === 标记），所以单看
 * parseBase 的 policies 会把指向托管组的规则全部误判孤立——任何做引用
 * 校验或喂选择器的地方都应使用本函数的结果，而非裸 parsed.policies。
 */
export function mergePolicyUniverse(managedGroupNames: string[], basePolicies: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of [...managedGroupNames, ...basePolicies]) {
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
