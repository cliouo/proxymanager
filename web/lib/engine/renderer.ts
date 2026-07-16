import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import type { Rule, RuleSet } from '@/schemas';
import { collectRuleSetReferencesFromRuleLine } from './ruleSetReferences';

export interface AnchorStats {
  anchor: string;
  ruleCount: number;
}

export interface RenderResult {
  content: string;
  buildId: string;
  anchorsApplied: AnchorStats[];
  unmatchedAnchors: string[];
  /** Names of rule-sets emitted into the `rule-providers:` block (referenced + enabled). */
  ruleProvidersApplied: string[];
  /**
   * True when the config references rule-sets (RULE-SET rules or base
   * `rule-set:` keys) that needed a `rule-providers:` declaration, but the base
   * has no `# === RULE-PROVIDERS ===` marker to inject at — so the declarations
   * were silently dropped and mihomo would abort with `not found rule-set`.
   * The caller must reject the render instead of publishing a partial config.
   */
  ruleProvidersMarkerMissing: boolean;
}

export interface RenderOptions {
  /** The rule-set library. Only entries referenced by an enabled RULE-SET rule are emitted. */
  providers?: RuleSet[];
  /**
   * Absolute base for local providers' URLs, e.g.
   * `https://host/api/rule-providers/<token>`. The provider name is appended.
   * Remote providers ignore this and use their own `url`.
   */
  providerUrlBase?: string;
}

const ANCHOR_LINE_PATTERN = /^([ \t]*)#\s*===\s*ANCHOR:\s*([\w-]+)\s*===\s*$/gm;
/** Where the managed `rule-providers:` block is injected. Distinct from rule anchors. */
const RULE_PROVIDERS_MARKER = /^[ \t]*#\s*===\s*RULE-PROVIDERS\s*===[ \t]*$/m;
/** Placeholder host shown when no real provider URL base is supplied (preview/AI views). */
const PLACEHOLDER_URL_BASE = '<rule-providers-base>';

export function renderRule(rule: Rule): string {
  if (rule.type === 'MATCH') return `MATCH,${rule.policy}`;
  const modifiers = rule.options?.length ? `,${rule.options.join(',')}` : '';
  return `${rule.type},${rule.value},${rule.policy}${modifiers}`;
}

export function groupRulesByAnchor(rules: Rule[]): Map<string, Rule[]> {
  const byAnchor = new Map<string, Rule[]>();
  for (const rule of rules) {
    const list = byAnchor.get(rule.anchor) ?? [];
    list.push(rule);
    byAnchor.set(rule.anchor, list);
  }
  for (const list of byAnchor.values()) {
    list.sort((a, b) => a.rank - b.rank);
  }
  return byAnchor;
}

/** Provider names referenced by RULE-SET rules among the given (already-active) rules. */
export function referencedProviderNames(rules: Rule[]): Set<string> {
  const refs = new Set<string>();
  for (const rule of rules) {
    if (rule.type === 'RULE-SET' && rule.value) refs.add(rule.value);
  }
  return refs;
}

/**
 * Rule-set names referenced from within the base text itself — chiefly mihomo
 * DNS `nameserver-policy` keys of the form `rule-set:foo,bar` (one key may name
 * several comma-joined rule-sets). Such a reference needs a `rule-providers:`
 * declaration just like a RULE-SET rule does, otherwise mihomo aborts at load
 * with `not found rule-set: <name>`. The renderer is otherwise blind to the base
 * body, so these references were silently dropped. Fixed Mihomo checks this
 * syntax only at string index 0 (case-insensitively); an embedded substring is
 * an ordinary domain/address value and must not activate a remote provider.
 */
export function referencedProviderNamesInText(text: string): Set<string> {
  const refs = new Set<string>();
  if (text.slice(0, 9).toLowerCase() !== 'rule-set:') return refs;
  const remainder = text.slice(9);
  // parseNameServerPolicy has an asymmetric fixed branch: comma-bearing keys
  // first truncate at the next `:`, while a single name preserves the entire
  // remainder verbatim.
  const names = text.includes(',') ? remainder.split(':', 1)[0] : remainder;
  addFixedRuleSetNames(refs, names);
  return refs;
}

/** Mirror fixed parseDomain/parseIPCIDR for sniffer and fake-IP scalar lists. */
export function referencedProviderNamesInColonList(text: string): Set<string> {
  const refs = new Set<string>();
  if (text.slice(0, 9).toLowerCase() !== 'rule-set:') return refs;
  addFixedRuleSetNames(refs, text.slice(9).split(':', 1)[0]);
  return refs;
}

function addFixedRuleSetNames(refs: Set<string>, names: string): void {
  for (const name of names.split(',')) {
    // Preserve an empty segment as a reference too: fixed Mihomo attempts to
    // resolve it and fails, so the final validator must not silently ignore it.
    refs.add(name);
  }
}

/**
 * Collect only rule-set references from YAML fields where fixed Mihomo
 * v1.19.28 interprets them. Scanning the whole text can mistake a comment,
 * password, URL, or other opaque scalar for executable `rule-set:` syntax and
 * inject an unrelated remote provider.
 */
export function referencedProviderNamesInBaseYaml(text: string): Set<string> {
  const refs = new Set<string>();
  let root: unknown;
  try {
    root = parse(text);
  } catch {
    return refs;
  }
  if (!isRecord(root)) return refs;

  const collectColonSequence = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item !== 'string') continue;
      for (const name of referencedProviderNamesInColonList(item)) refs.add(name);
    }
  };
  const collectRuleSequence = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item !== 'string') continue;
      collectRuleSetReferencesFromRuleLine(item, refs);
    }
  };
  const collectDirectNameSequence = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      // Fixed TUN lookup attempts even empty/whitespace names and fails. Keep
      // them so availability validation does the same instead of ignoring.
      if (typeof item === 'string') refs.add(item);
    }
  };

  const dns = isRecord(root.dns) ? root.dns : undefined;
  if (dns) {
    for (const field of ['nameserver-policy', 'proxy-server-nameserver-policy']) {
      const policies = isRecord(dns[field]) ? dns[field] : undefined;
      if (policies) {
        for (const key of Object.keys(policies)) {
          for (const name of referencedProviderNamesInText(key)) refs.add(name);
        }
      }
    }
    // Fixed Mihomo does not parse fake-ip-filter at all outside fake-IP mode;
    // both DNS enums are case-insensitive TextUnmarshalers.
    if (equalsAsciiCaseInsensitive(dns['enhanced-mode'], 'fake-ip')) {
      if (equalsAsciiCaseInsensitive(dns['fake-ip-filter-mode'], 'rule')) {
        collectRuleSequence(dns['fake-ip-filter']);
      } else {
        collectColonSequence(dns['fake-ip-filter']);
      }
    }
  }

  const sniffer = isRecord(root.sniffer) ? root.sniffer : undefined;
  if (sniffer) {
    for (const field of ['force-domain', 'skip-domain', 'skip-src-address', 'skip-dst-address']) {
      collectColonSequence(sniffer[field]);
    }
  }

  const collectTunRuleSets = (tun: unknown, requireEnabled: boolean): void => {
    const autoRouteEnabled =
      isRecord(tun) &&
      (tun['auto-route'] === true || (requireEnabled && tun['auto-route'] === undefined));
    if (
      !isRecord(tun) ||
      tun['auto-redirect'] !== true ||
      !autoRouteEnabled ||
      (requireEnabled && tun.enable !== true)
    ) {
      return;
    }
    collectDirectNameSequence(tun['route-address-set']);
    collectDirectNameSequence(tun['route-exclude-address-set']);
  };
  collectTunRuleSets(root.tun, true);
  if (Array.isArray(root.listeners)) {
    for (const listener of root.listeners) {
      if (isRecord(listener) && listener.type === 'tun') collectTunRuleSets(listener, false);
    }
  }

  collectRuleSequence(root.rules);
  const subRules = isRecord(root['sub-rules']) ? root['sub-rules'] : undefined;
  if (subRules) {
    for (const rules of Object.values(subRules)) collectRuleSequence(rules);
  }
  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalsAsciiCaseInsensitive(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected;
}

/**
 * Build the `rule-providers:` YAML block for the subset of `providers` that are
 * referenced by `refs` (an enabled RULE-SET rule points at them). A rule-set is
 * "off" simply by having no enabled rule reference it. Returns '' when empty.
 */
function renderRuleProviders(
  providers: RuleSet[],
  refs: Set<string>,
  urlBase: string,
): { block: string; applied: string[] } {
  const used = providers
    .filter((p) => refs.has(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (used.length === 0) return { block: '', applied: [] };

  const map: Record<string, Record<string, unknown>> = {};
  for (const p of used) {
    const decl: Record<string, unknown> = { type: 'http' };
    if (p.behavior) decl.behavior = p.behavior;
    decl.format = p.format;
    decl.url = p.source === 'remote' ? p.url : `${urlBase}/${p.name}`;
    decl.interval = p.interval ?? 86400;
    if (p.proxy) decl.proxy = p.proxy;
    map[p.name] = decl;
  }
  const block = stringify({ 'rule-providers': map }).trimEnd();
  return { block, applied: used.map((p) => p.name) };
}

export function renderBase(
  baseContent: string,
  rules: Rule[],
  opts: RenderOptions = {},
): RenderResult {
  // Parked rules (enabled === false) stay in the hash but never reach the
  // rendered config. Legacy rules have no `enabled` field and render normally.
  const active = rules.filter((rule) => rule.enabled !== false);
  const byAnchor = groupRulesByAnchor(active);
  const seenAnchors = new Set<string>();
  const stats: AnchorStats[] = [];

  let content = baseContent.replace(ANCHOR_LINE_PATTERN, (line, indent: string, name: string) => {
    seenAnchors.add(name);
    const matched = byAnchor.get(name);
    if (!matched || matched.length === 0) {
      stats.push({ anchor: name, ruleCount: 0 });
      return line;
    }
    stats.push({ anchor: name, ruleCount: matched.length });
    const rendered = matched.map((r) => `${indent}- ${renderRule(r)}`).join('\n');
    return `${line}\n${rendered}`;
  });

  // Inject the managed rule-providers block at its marker — every rule-set the
  // final config references must be declared here. That's both the enabled
  // RULE-SET rules and any `rule-set:` reference baked into the base body (e.g.
  // DNS nameserver-policy keys), or mihomo aborts with `not found rule-set: …`.
  const refs = referencedProviderNames(active);
  for (const name of referencedProviderNamesInBaseYaml(baseContent)) refs.add(name);
  const { block, applied } = renderRuleProviders(
    opts.providers ?? [],
    refs,
    opts.providerUrlBase ?? PLACEHOLDER_URL_BASE,
  );
  // If there's a block to inject but no marker to inject it at, `replace` is a
  // silent no-op — the config keeps its RULE-SET references with no matching
  // `rule-providers:` declaration (mihomo: `not found rule-set: <name>`). Detect
  // that and report it truthfully rather than claiming the providers applied.
  const markerPresent = RULE_PROVIDERS_MARKER.test(content);
  const ruleProvidersMarkerMissing = block.length > 0 && !markerPresent;
  content = content.replace(RULE_PROVIDERS_MARKER, () => block);

  const unmatchedAnchors: string[] = [];
  for (const anchor of byAnchor.keys()) {
    if (!seenAnchors.has(anchor)) unmatchedAnchors.push(anchor);
  }

  const buildId = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);

  return {
    content,
    buildId,
    anchorsApplied: stats,
    unmatchedAnchors,
    // Only claim providers were applied if they actually reached the config.
    ruleProvidersApplied: ruleProvidersMarkerMissing ? [] : applied,
    ruleProvidersMarkerMissing,
  };
}
