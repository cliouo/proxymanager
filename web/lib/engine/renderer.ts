import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { Rule, RuleSet } from '@/schemas';

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
 * body, so these references were silently dropped. Spurious matches are harmless:
 * {@link renderRuleProviders} only emits names that exist in the library.
 */
const RULE_SET_REF_PATTERN = /rule-set:([A-Za-z0-9_.!-]+(?:,[A-Za-z0-9_.!-]+)*)/g;

export function referencedProviderNamesInText(text: string): Set<string> {
  const refs = new Set<string>();
  for (const match of text.matchAll(RULE_SET_REF_PATTERN)) {
    for (const name of match[1].split(',')) {
      if (name) refs.add(name);
    }
  }
  return refs;
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

  let content = baseContent.replace(
    ANCHOR_LINE_PATTERN,
    (line, indent: string, name: string) => {
      seenAnchors.add(name);
      const matched = byAnchor.get(name);
      if (!matched || matched.length === 0) {
        stats.push({ anchor: name, ruleCount: 0 });
        return line;
      }
      stats.push({ anchor: name, ruleCount: matched.length });
      const rendered = matched.map((r) => `${indent}- ${renderRule(r)}`).join('\n');
      return `${line}\n${rendered}`;
    },
  );

  // Inject the managed rule-providers block at its marker — every rule-set the
  // final config references must be declared here. That's both the enabled
  // RULE-SET rules and any `rule-set:` reference baked into the base body (e.g.
  // DNS nameserver-policy keys), or mihomo aborts with `not found rule-set: …`.
  const refs = referencedProviderNames(active);
  for (const name of referencedProviderNamesInText(baseContent)) refs.add(name);
  const { block, applied } = renderRuleProviders(
    opts.providers ?? [],
    refs,
    opts.providerUrlBase ?? PLACEHOLDER_URL_BASE,
  );
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
    ruleProvidersApplied: applied,
  };
}
