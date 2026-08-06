/**
 * Deterministic structured naming — placeholder-template DSL (rename-template
 * operator).
 *
 * Managed naming is driven by ONE persisted source of truth: a bounded
 * placeholder template string. No presets, no per-component switches, no
 * global separator setting — separators are literal template text, so users
 * and the AI can freely place literals between fields.
 *
 * DSL grammar (closed whitelist — nothing else is accepted):
 *   - `${field}`             a required placeholder
 *   - `${field:mod}`         a placeholder with a bounded format modifier
 *   - `${?field: content}`   an OPTIONAL segment: when `field` is missing or
 *                            empty, the WHOLE segment (its literals included)
 *                            is dropped — no doubled or dangling separators
 *   - `$$`                   literal `$` (the documented escape; `${` written
 *                            as `$${` renders literally)
 *   - everything else        literal text, kept verbatim
 *
 * Fields: emoji · region · region_code · entry · route · vendor · source ·
 * protocol · rate · index · note.
 * Modifiers: `${index:N}` (N = 1–4 digit zero-pad width), `${rate:include1x}`
 * (render "1x" too — default omits it), `${protocol:upper}` /
 * `${protocol:lower}` (protocol casing). Any other modifier is rejected.
 *
 * Validation rejects: unknown placeholders, malformed syntax, nesting deeper
 * than {@link MAX_TEMPLATE_NESTING}, templates longer than
 * {@link MAX_TEMPLATE_LENGTH}, and templates with no required content (they
 * could render empty). There is NO eval, no loop, no function call and no
 * arbitrary code anywhere in the grammar.
 *
 * The executor (applyRenameTemplate) is pure + deterministic: same nodes +
 * same config ⇒ same output; re-running over its own output is a no-op. It
 * never depends on an AI call, network state or wall-clock — the AI flow
 * (lib/ai/namingAnalysis + naming actions) only *suggests* a template; once
 * saved, THIS module is the sole executor for subscription rendering,
 * collection resolution, export and preview.
 *
 * True deduplication is identity-based (server:port), never display-name
 * based: same name + different identity ⇒ both nodes survive (with a
 * deterministic meaningful disambiguation suffix); same identity + different
 * names ⇒ one node, kept by explicit source-priority policy (first source in
 * input order wins) with diagnostic provenance in `deduped`.
 */

import { codeFromFlag, flagFromCode, REGIONS, regionByCode, stripFlags } from './regions';
import {
  envelopeOf,
  fingerprintOf,
  mergeEnvelope,
  sourceOf,
  type ProvenancedProxy,
  type SourceIdentity,
} from './provenance';

/* ─── the field whitelist ──────────────────────────────────────────── */

export const NAMING_FIELDS = [
  'emoji',
  'region',
  'region_code',
  'entry',
  'route',
  'vendor',
  'source',
  'protocol',
  'rate',
  'index',
  'note',
] as const;
export type NamingField = (typeof NAMING_FIELDS)[number];

export const MAX_TEMPLATE_LENGTH = 512;
export const MAX_TEMPLATE_NESTING = 2;
export const MAX_RECOGNITION_RULES = 32;
export const MAX_RECOGNITION_RULE_PATTERN_LENGTH = 100;
export const MAX_RECOGNITION_RULE_VALUE_LENGTH = 24;

/* ─── config shape (mirrors the zod schema in schemas/operator.ts) ──── */

export interface RecognitionRule {
  /** Bounded, safe regex — a validated rule, never arbitrary code. */
  pattern: string;
  field: 'route' | 'vendor' | 'region' | 'entry';
  /** Bounded replacement fact label. */
  value: string;
}

export interface RenameTemplateConfig {
  /** The placeholder template — the persisted source of truth. */
  template: string;
  /** TW nodes get the CN flag (same toggle as the flag-emoji operator). */
  tw2cn?: boolean;
  /** Manual alias overrides, keyed by the stable source slug. */
  sourceAliases?: Record<string, string>;
  /** Saved, validated recognition overrides (AI-rule facts). */
  recognitionRules?: RecognitionRule[];
}

/* ─── default templates ────────────────────────────────────────────── */

/**
 * The redesigned default: flag and region are ONE visual block with a normal
 * space (🇭🇰 香港), optional segments carry their own ` · ` literal separators
 * and disappear completely when the field is missing. Residual (`note`)
 * fragments are intentionally omitted — anime-style decorations can stay
 * hidden while the flag-derived region remains.
 */
export const DEFAULT_NAMING_TEMPLATE =
  '${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}';

/** Single-subscription variant: no member-source segment. */
export const SINGLE_SUB_DEFAULT_TEMPLATE =
  '${emoji} ${region}${?route: · ${route}}${?index: · ${index}}${?rate: · ${rate}}';

/**
 * Deterministic recommended path for a new rename-template: collections
 * include the member-source segment, single subscriptions do not.
 */
export function defaultTemplateFor(aggregate: boolean): string {
  return aggregate ? DEFAULT_NAMING_TEMPLATE : SINGLE_SUB_DEFAULT_TEMPLATE;
}

/* ─── DSL compiler ─────────────────────────────────────────────────── */

export type TemplateToken =
  | { type: 'literal'; text: string }
  | { type: 'field'; field: NamingField; mod?: string }
  | { type: 'optional'; field: NamingField; children: TemplateToken[] };

/** Bounded structural description of a template — the ONLY template-derived
 * data that may leave the server for audits or AI payloads (pass-2 finding):
 * the raw placeholder DSL string itself is never persisted or serialized.
 */
export interface TemplateSummary {
  /** Placeholder tokens in the closed DSL (nested optionals counted). */
  placeholderCount: number;
  /** Template string length (structural). */
  length: number;
  /** Distinct placeholder field names (closed DSL enum), bounded. */
  placeholders: string[];
}

/**
 * Structural, non-reversible template description. Counts closed-DSL
 * placeholder tokens via the real parser (never string scanning); a
 * schema-validated template can only contain allowlisted fields, so the
 * returned names are enum values, never free text.
 */
export function summarizeTemplate(template: string | undefined): TemplateSummary {
  if (template === undefined) return { placeholderCount: 0, length: 0, placeholders: [] };
  let placeholderCount = 0;
  const placeholders = new Set<string>();
  const walk = (tokens: TemplateToken[]): void => {
    for (const token of tokens) {
      if (token.type === 'field') {
        placeholderCount += 1;
        placeholders.add(token.field);
      } else if (token.type === 'optional') {
        walk(token.children);
      }
    }
  };
  try {
    walk(compileTemplate(template));
  } catch {
    // schema-validated upstream; never mint a misleading summary
  }
  return {
    placeholderCount,
    length: template.length,
    placeholders: [...placeholders].sort(),
  };
}

/** Thrown by compileTemplate on any DSL violation. Messages are safe + static. */
export class TemplateSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

/** Bounded per-field modifiers — anything else is rejected. */
const FIELD_MODS: Record<NamingField, ReadonlyArray<string> | null> = {
  emoji: null,
  region: null,
  region_code: null,
  entry: null,
  route: null,
  vendor: null,
  source: null,
  protocol: ['upper', 'lower'],
  rate: ['include1x'],
  index: null, // numeric width handled separately
  note: null,
};

/** Upper bound for the ${index:N} zero-pad width — 1 through 4 digits. */
export const MAX_INDEX_WIDTH = 4;

function isField(value: string): value is NamingField {
  return (NAMING_FIELDS as readonly string[]).includes(value);
}

function isIndexWidth(mod: string): boolean {
  if (!/^\d{1,2}$/.test(mod)) return false;
  const width = Number(mod);
  return Number.isInteger(width) && width >= 1 && width <= MAX_INDEX_WIDTH;
}

/** Parse one `${...}` placeholder body (without the outer braces). */
function parsePlaceholderBody(body: string, depth: number): TemplateToken {
  if (body.startsWith('?')) {
    // ${?field: content} — content may contain nested placeholders.
    const colon = body.indexOf(':');
    if (colon === -1) {
      throw new TemplateSyntaxError('可选片段缺少冒号，应为 ${?字段: 内容}');
    }
    const fieldRaw = body.slice(1, colon).trim();
    const content = body.slice(colon + 1);
    if (!isField(fieldRaw)) {
      throw new TemplateSyntaxError(`未知占位符 ${body.slice(0, colon)}`);
    }
    if (content.trim() === '') {
      throw new TemplateSyntaxError('可选片段内容不能为空');
    }
    if (depth + 1 > MAX_TEMPLATE_NESTING) {
      throw new TemplateSyntaxError(`可选片段嵌套最多 ${MAX_TEMPLATE_NESTING} 层`);
    }
    return {
      type: 'optional',
      field: fieldRaw,
      children: parseTokens(content, depth + 1),
    };
  }
  const colon = body.indexOf(':');
  const fieldRaw = colon === -1 ? body.trim() : body.slice(0, colon).trim();
  const modRaw = colon === -1 ? undefined : body.slice(colon + 1).trim();
  if (!isField(fieldRaw)) {
    throw new TemplateSyntaxError(`未知占位符 ${fieldRaw}`);
  }
  let mod: string | undefined;
  if (modRaw !== undefined) {
    if (modRaw === '') {
      throw new TemplateSyntaxError(`占位符 ${fieldRaw} 的格式修饰符为空`);
    }
    if (fieldRaw === 'index') {
      // ${index:N} — bounded numeric zero-pad width, handled separately.
      if (!isIndexWidth(modRaw)) {
        throw new TemplateSyntaxError('${index} 的宽度修饰符必须是 1–4 位数字');
      }
      mod = modRaw;
    } else {
      const allowed = FIELD_MODS[fieldRaw];
      if (allowed === null) {
        throw new TemplateSyntaxError(`占位符 ${fieldRaw} 不支持格式修饰符`);
      }
      if (!allowed.includes(modRaw)) {
        throw new TemplateSyntaxError(`占位符 ${fieldRaw} 的修饰符 ${modRaw} 不受支持`);
      }
      mod = modRaw;
    }
  }
  return { type: 'field', field: fieldRaw, ...(mod !== undefined ? { mod } : {}) };
}

/**
 * Find the `}` that closes the placeholder opened at `start` (`${`), skipping
 * `$$` escapes and balancing nested `${...}` inside optional-segment content.
 * Returns -1 when unbalanced.
 */
function findPlaceholderEnd(text: string, start: number): number {
  let depth = 0;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '$') {
      const next = text[i + 1];
      if (next === '$') {
        i += 2;
        continue;
      }
      if (next === '{') {
        depth += 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) return i;
      depth -= 1;
    }
    i += 1;
  }
  return -1;
}

function parseTokens(text: string, depth: number): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let literal = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '$') {
      const next = text[i + 1];
      if (next === '$') {
        literal += '$';
        i += 2;
        continue;
      }
      if (next === '{') {
        if (literal !== '') {
          tokens.push({ type: 'literal', text: literal });
          literal = '';
        }
        const end = findPlaceholderEnd(text, i);
        if (end === -1) {
          throw new TemplateSyntaxError('占位符缺少闭合的 }');
        }
        const body = text.slice(i + 2, end);
        tokens.push(parsePlaceholderBody(body, depth));
        i = end + 1;
        continue;
      }
      // A lone `$` is literal text (tolerant — prices etc. stay intact).
      literal += '$';
      i += 1;
      continue;
    }
    literal += ch;
    i += 1;
  }
  if (literal !== '') tokens.push({ type: 'literal', text: literal });
  return tokens;
}

/**
 * Whether the token sequence contains any REQUIRED (non-optional) content:
 * a required placeholder, or a literal carrying at least one non-separator
 * character (a template made only of separators + optional segments could
 * still render empty and is rejected).
 */
function hasRequiredContent(tokens: TemplateToken[]): boolean {
  return tokens.some(
    (t) => (t.type === 'literal' && /[^\s\-_·|:：,，]/.test(t.text)) || t.type === 'field',
  );
}

/**
 * Compile a template into its token tree. Throws {@link TemplateSyntaxError}
 * on any DSL violation — the schema and the UI both surface these messages.
 */
export function compileTemplate(template: string): TemplateToken[] {
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw new TemplateSyntaxError(`模板过长（最多 ${MAX_TEMPLATE_LENGTH} 字符）`);
  }
  const tokens = parseTokens(template, 0);
  if (!hasRequiredContent(tokens)) {
    throw new TemplateSyntaxError('模板没有任何必填内容（全是可选片段时可能生成空名称）');
  }
  return tokens;
}

export type TemplateValidation =
  | { ok: true; tokens: TemplateToken[] }
  | { ok: false; message: string };

/** Validate a template without throwing — shared by schema + workbench. */
export function validateTemplate(template: string): TemplateValidation {
  try {
    const tokens = compileTemplate(template);
    return { ok: true, tokens };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof TemplateSyntaxError ? error.message : '模板不合法',
    };
  }
}

/* ─── rendering ────────────────────────────────────────────────────── */

/**
 * Pre-formatted field values fed to the renderer. `rate` is the formatted
 * "Nx" text (the omit-1x policy is applied by the renderer), `index` the
 * zero-padded ordinal (width modifiers are applied by the renderer).
 */
export interface RenderContext {
  emoji?: string;
  region?: string;
  regionCode?: string;
  entry?: string;
  route?: string;
  vendor?: string;
  source?: string;
  protocol?: string;
  rate?: string;
  index?: string;
  note?: string;
}

function present(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function applyFieldMod(token: { field: NamingField; mod?: string }, value: string): string {
  const mod = token.mod;
  if (!mod) return value;
  if (token.field === 'index') {
    // Bounded at parse time; clamp again here so a corrupted persisted row
    // can never allocate attacker-sized output.
    const width = Math.min(MAX_INDEX_WIDTH, Math.max(1, Number(mod)));
    const numeric = Number.parseInt(value, 10);
    // The executor pre-pads source ordinals to at least two digits. Accept
    // that canonical digit-only value here so `${index:N}` can widen it.
    if (Number.isFinite(numeric) && /^[0-9]+$/.test(value.trim())) {
      return String(numeric).padStart(width, '0');
    }
    return value;
  }
  if (token.field === 'protocol') {
    return mod === 'upper' ? value.toUpperCase() : value.toLowerCase();
  }
  if (token.field === 'rate') {
    // `${rate:include1x}` renders 1x too; the bare `${rate}` omits it below.
    return value;
  }
  return value;
}

function renderTokens(tokens: TemplateToken[], ctx: RenderContext): string {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'literal') {
      out += token.text;
      continue;
    }
    if (token.type === 'field') {
      const value = fieldValue(token.field, ctx);
      if (!present(value)) continue;
      // ${rate} omits 1x by design; only ${rate:include1x} renders it.
      if (token.field === 'rate' && token.mod !== 'include1x' && value === '1x') continue;
      out += applyFieldMod(token, value as string);
      continue;
    }
    // optional segment: dropped ENTIRELY (literals included) when absent
    const value = fieldValue(token.field, ctx);
    if (!present(value)) continue;
    out += renderTokens(token.children, ctx);
  }
  return out;
}

/** Resolve a field's raw value from the render context. */
function fieldValue(field: NamingField, ctx: RenderContext): string | undefined {
  switch (field) {
    case 'emoji':
      return ctx.emoji;
    case 'region':
      return ctx.region;
    case 'region_code':
      return ctx.regionCode;
    case 'entry':
      return ctx.entry;
    case 'route':
      return ctx.route;
    case 'vendor':
      return ctx.vendor;
    case 'source':
      return ctx.source;
    case 'protocol':
      return ctx.protocol;
    case 'rate':
      return ctx.rate;
    case 'index':
      return ctx.index;
    case 'note':
      return ctx.note;
  }
}

/**
 * Collapse whitespace + trim stray separators at both ends. The DSL keeps
 * literal whitespace; rendering normalizes runs to a single space and never
 * leaves a dangling `·` when an earlier required field was missing.
 */
function tidyRendered(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-_·|:：,，]+/, '')
    .replace(/[\s\-_·|:：,，]+$/, '')
    .trim();
}

/** Render a compiled template against a context. Empty ⇒ ''. */
export function renderTemplate(tokens: TemplateToken[], ctx: RenderContext): string {
  return tidyRendered(renderTokens(tokens, ctx));
}

/* ─── identity attachment (shared raw boundary) ─────────────────────── */

/**
 * Attach raw-boundary provenance to a proxy: source identity + the raw name +
 * the immutable identity fingerprint computed from THIS raw (pre-operator)
 * object. Every caller that sits at the fetch boundary — the fetcher, the
 * preview routes, the AI source loader, the workspace route — must use this
 * so later stages fingerprint the SAME raw identity, never a post-transform
 * configuration.
 */
export function withRawIdentity(
  proxy: Record<string, unknown>,
  identity: SourceIdentity,
): ProvenancedProxy {
  return mergeEnvelope(proxy, {
    source: identity,
    rawName: typeof proxy.name === 'string' ? proxy.name : '',
    fingerprint: nodeFingerprint(proxy) ?? undefined,
  });
}

/* ─── recognition ──────────────────────────────────────────────────── */

export interface RecognizedName {
  /** ISO-ish region code (alpha-2), or null when nothing reliable matched. */
  region: string | null;
  /** Rate multiplier, or null. */
  rate: number | null;
  /** Canonical route label (中转 / 直连 / 落地 / 入口), or null. */
  route: string | null;
  /** '入口' when the entry token was the matched route, else null. */
  entry: string | null;
  /** Canonical vendor label, or null. */
  vendor: string | null;
  /** Residual display fragment after removing recognised tokens. */
  base: string;
  /** Region signals found (flag emoji + table hits) — >1 means ambiguous. */
  regionSignals: number;
  /** Distinct route tokens found — >1 means ambiguous. */
  routeSignals: number;
  /**
   * Per-field confidence: explicit flag emoji ⇒ high; conservative-table or
   * keyword hits ⇒ medium; any conflict (flag vs keyword, multiple routes)
   * ⇒ low. Absent fields carry no entry (unknown stays unknown).
   */
  confidence: Partial<Record<NamingField, FactConfidence>>;
  /** Fields whose extraction was ambiguous (multiple conflicting signals). */
  ambiguousFields: NamingField[];
}

/** Recognition fact confidence — high / medium / low (unknown = absent). */
export type FactConfidence = 'high' | 'medium' | 'low';

/** Bounded rate pattern: 1–3 integer digits, ≤2 fraction digits, x/× suffix. */
const RATE_RE = /(?:^|[^0-9A-Za-z])(\d{1,3}(?:\.\d{1,2})?)\s*[x×](?![0-9A-Za-z])/;

/**
 * Conservative route tokens — entry/transit/exit semantics, bounded + word-
 * matched for Latin forms so "entry" never fires inside "elementary".
 * Token regexes are matched with `exec` — NEVER /g (lastIndex would leak
 * state across calls and make recognition non-deterministic).
 */
const ROUTE_TOKENS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /中转|\brelay\b/i, label: '中转' },
  { re: /直连|直連|\bdirect\b/i, label: '直连' },
  { re: /落地|\blanding\b/i, label: '落地' },
  { re: /入口|\bentry\b/i, label: '入口' },
];

/**
 * Conservative vendor hints (common airport brands). Optional component —
 * anything not in this bounded table is simply omitted, never guessed.
 */
const VENDOR_TOKENS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bnexitally\b/i, label: 'Nexitally' },
  { re: /魔戒/, label: '魔戒' },
  { re: /\btag\b/i, label: 'TAG' },
  { re: /\bn3\b/i, label: 'N3' },
  { re: /\bwgetcloud\b/i, label: 'WgetCloud' },
  { re: /稳狗/, label: '稳狗' },
  { re: /\bflowercloud\b/i, label: 'FlowerCloud' },
  { re: /花云/, label: '花云' },
  { re: /\bmiacloud\b/i, label: 'MiaCloud' },
  { re: /蜜云/, label: '蜜云' },
  { re: /\bholafly\b/i, label: 'HolaFly' },
  { re: /\bcloudseeker\b/i, label: 'CloudSeeker' },
];

interface TokenHit {
  label: string;
  start: number;
  end: number;
}

function firstTokenHit(
  text: string,
  table: ReadonlyArray<{ re: RegExp; label: string }>,
): TokenHit | null {
  for (const entry of table) {
    const m = entry.re.exec(text);
    if (m) return { label: entry.label, start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** First region-table pattern hit — same iteration order as detectRegion. */
function firstRegionHit(text: string): { code: string; start: number; end: number } | null {
  for (const region of REGIONS) {
    for (const pattern of region.patterns) {
      const m = pattern.exec(text);
      if (m) return { code: region.code, start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

/** Count DISTINCT region codes hit (flag counts once) — ambiguity signal. */
function countRegionSignals(text: string, flagCode: string | null): number {
  const codes = new Set<string>();
  if (flagCode) codes.add(flagCode);
  for (const region of REGIONS) {
    for (const pattern of region.patterns) {
      if (pattern.test(text)) {
        codes.add(region.code);
        break;
      }
    }
  }
  return codes.size;
}

/** Count DISTINCT route tokens hit — ambiguity signal. */
function countRouteSignals(text: string): number {
  const labels = new Set<string>();
  for (const entry of ROUTE_TOKENS) {
    if (entry.re.test(text)) labels.add(entry.label);
  }
  return labels.size;
}

/** Collapse whitespace + trim stray separators at both ends. */
function tidyFragment(fragment: string): string {
  return fragment
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_·|:：,，]+/, '')
    .replace(/[\s\-_·|:：,，]+$/, '')
    .trim();
}

/** Compile a recognition-rule pattern (validated by the schema already). */
function compileRulePattern(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

/**
 * Apply saved recognition rules deterministically AFTER the built-in tables:
 * the first match in rule order overrides the field and its span is removed
 * from the residual base (so the fact never duplicates itself in output).
 */
function applyRecognitionRules(
  recognized: RecognizedName,
  name: string,
  rules: RecognitionRule[] | undefined,
): RecognizedName {
  if (!rules || rules.length === 0) return recognized;
  let base = recognized.base;
  let region = recognized.region;
  let route = recognized.route;
  let entry = recognized.entry;
  let vendor = recognized.vendor;
  const confidence = { ...recognized.confidence };
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = compileRulePattern(rule.pattern);
    } catch {
      continue; // schema-validated; never reachable at runtime
    }
    const m = re.exec(name);
    if (!m) continue;
    const value = rule.value.trim();
    if (value === '') continue;
    switch (rule.field) {
      case 'region':
        region = value.toUpperCase();
        break;
      case 'route':
        route = value;
        entry = value === '入口' ? '入口' : null;
        break;
      case 'entry':
        entry = value;
        break;
      case 'vendor':
        vendor = value;
        break;
    }
    // Remove the rule's matched span from the residual so the fact never
    // duplicates itself in the rendered name. The span is matched against
    // the RAW name; replacing it in the residual is literal (never regex).
    const span = name.slice(m.index, m.index + m[0].length);
    if (span !== '') {
      base = base.replace(span, ' ');
    }
    // A SAVED validated rule is authoritative: the overridden field fact is
    // high-confidence (ai-rule provenance is tracked by the health layer).
    confidence[rule.field] = 'high';
  }
  return {
    ...recognized,
    region,
    route,
    entry,
    vendor,
    base: tidyFragment(base),
    confidence,
  };
}

/**
 * Deterministic local recognition of a raw node name. Only reliable signals
 * are extracted; everything else stays in `base` untouched. `rules` are the
 * saved, validated recognition overrides (see {@link RecognitionRule}).
 */
export function recognizeName(name: string, rules?: RecognitionRule[]): RecognizedName {
  const flagCode = codeFromFlag(name);
  let base = stripFlags(name);

  let region: string | null = flagCode;
  const hit = firstRegionHit(base);
  if (hit) {
    if (region === null) region = hit.code;
    base = `${base.slice(0, hit.start)} ${base.slice(hit.end)}`;
  }

  let rate: number | null = null;
  const rm = RATE_RE.exec(base);
  if (rm) {
    rate = Number.parseFloat(rm[1]);
    base = `${base.slice(0, rm.index)} ${base.slice(rm.index + rm[0].length)}`;
  }

  let route: string | null = null;
  const rt = firstTokenHit(base, ROUTE_TOKENS);
  if (rt) {
    route = rt.label;
    base = `${base.slice(0, rt.start)} ${base.slice(rt.end)}`;
  }

  const entry: string | null = route === '入口' ? '入口' : null;

  let vendor: string | null = null;
  const vt = firstTokenHit(base, VENDOR_TOKENS);
  if (vt) {
    vendor = vt.label;
    base = `${base.slice(0, vt.start)} ${base.slice(vt.end)}`;
  }

  const regionSignals = countRegionSignals(name, flagCode);
  const routeSignals = countRouteSignals(name);
  const confidence: Partial<Record<NamingField, FactConfidence>> = {};
  const ambiguousFields: NamingField[] = [];
  if (region !== null) {
    // explicit flag emoji = high; table keyword/code hit = medium; any
    // conflicting signal = low + ambiguous
    confidence.region = flagCode !== null ? 'high' : regionSignals > 1 ? 'low' : 'medium';
    if (regionSignals > 1) ambiguousFields.push('region');
  }
  if (rate !== null) confidence.rate = 'high';
  if (route !== null) {
    confidence.route = routeSignals > 1 ? 'low' : 'medium';
    if (routeSignals > 1) ambiguousFields.push('route');
  }
  if (entry !== null) confidence.entry = 'medium';
  if (vendor !== null) confidence.vendor = 'medium';
  if (base !== '') confidence.note = 'high';
  const recognized: RecognizedName = {
    region,
    rate,
    route,
    entry: route === '入口' ? '入口' : null,
    vendor,
    base: tidyFragment(base),
    // Ambiguity is judged on the ORIGINAL name (pre-strip), where every
    // signal still exists.
    regionSignals,
    routeSignals,
    confidence,
    ambiguousFields,
  };
  return applyRecognitionRules(recognized, name, rules);
}

/* ─── formatting ───────────────────────────────────────────────────── */

export function formatRate(rate: number): string {
  const text = Number.isInteger(rate) ? String(rate) : String(Number(rate.toFixed(2)));
  return `${text}x`;
}

/** Region label for output — zh label or alpha-2 code, from the shared table. */
export function regionLabelFor(code: string, style: 'zh' | 'code'): string {
  if (style === 'code') return code;
  return regionByCode(code)?.zh ?? code;
}

export interface FormatNodeOptions {
  name: string;
  type?: string;
  source?: SourceIdentity | null;
  /** 1-based per-source ordinal (input order). */
  index?: number;
  /** Zero-pad width for the ordinal. */
  indexWidth?: number;
  config: RenameTemplateConfig;
}

/** Escape a literal for safe use in a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove every delimiter-bounded occurrence of `literal` from `text`. */
function stripDelimited(text: string, literal: string): string {
  const escaped = escapeRegExp(literal);
  return text
    .replace(new RegExp(`(?:^|[\\s\\-_·|:：])${escaped}(?=$|[\\s\\-_·|:：])`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_·|:：,，]+/, '')
    .replace(/[\s\-_·|:：,，]+$/, '')
    .trim();
}

/** Whether the template contains a `${index}` placeholder (any depth). */
function templateUsesIndex(tokens: TemplateToken[]): boolean {
  return tokens.some(
    (t) =>
      (t.type === 'field' && t.field === 'index') ||
      (t.type === 'optional' && templateUsesIndex(t.children)),
  );
}

/**
 * Public predicate for ordinal consumers (the ordinal service must skip
 * upstream-ordinal nodes exactly like the executor does). Invalid templates
 * are treated as not using the index.
 */
export function templateUsesIndexField(template: string): boolean {
  return templateUsesIndex(compileTemplateSafe(template));
}

/** Whether the template references the `${source}` field (any depth). */
function templateUsesSource(tokens: TemplateToken[]): boolean {
  return tokens.some(
    (t) =>
      (t.type === 'field' && t.field === 'source') ||
      (t.type === 'optional' && t.field === 'source'),
  );
}

/**
 * Extract the upstream ordinal from a residual base — "香港 01" or a purely
 * numeric residual ("01") — so numbering REUSES the upstream ordinal when it
 * is unambiguous (stable across upstream reordering). Returns null when no
 * unambiguous ordinal exists; the caller then falls back to input order.
 */
export function upstreamOrdinalOf(base: string): number | null {
  if (/^\d{1,6}$/.test(base)) return Number.parseInt(base, 10);
  const trailing = base.match(/[\s\-_·|:：]{1,4}(\d{1,3})$/);
  if (trailing) return Number.parseInt(trailing[1], 10);
  return null;
}

/**
 * Compose the deterministic output name from the placeholder template. Empty
 * optional segments are dropped before joining (no doubled or dangling
 * separators); a fully empty result falls back to the original name — a
 * rename-template never emits an empty node name.
 */
export function formatNodeName(opts: FormatNodeOptions): string {
  const { name, config } = opts;
  let tokens: TemplateToken[];
  try {
    tokens = compileTemplate(config.template);
  } catch {
    // A schema-validated template never fails here; belt-and-braces fallback
    // keeps a corrupted persisted row from emitting garbage.
    return name;
  }
  const usesIndex = templateUsesIndex(tokens);
  const usesSource = templateUsesSource(tokens);

  // The selected source alias is normalized ONCE: the same trimmed literal is
  // used for matching (stripping an already-present component) and for output,
  // so a whitespace-padded override can never duplicate on pass two.
  let alias: string | null = null;
  if (usesSource && opts.source) {
    alias = opts.source.key ? (config.sourceAliases?.[opts.source.key] ?? opts.source.label) : null;
    if (alias) {
      alias = alias.trim();
      if (alias === '') alias = null;
    }
  }

  // A trailing collision suffix (` #N` from a previous pass) is a STABLE
  // component: it must never be re-interpreted as an ordinal, a rate or base
  // content. It is split off before semantic recognition and re-appended
  // verbatim after composition, so indexed collisions re-run byte-identically
  // with no ordinal or ` #N` churn.
  const suffixMatch = name.match(/[\s\-_·|:：]{1,4}#\d{1,3}$/);
  const collisionSuffix = suffixMatch ? suffixMatch[0].trim() : null;
  const recognitionName = collisionSuffix
    ? name.slice(0, name.length - (suffixMatch as RegExpMatchArray)[0].length)
    : name;

  // Semantic recognition runs on the ALIAS-STRIPPED copy: table-order
  // recognition of the unstripped name lets a generated alias component
  // (香港 in a later position) steal recognition from an earlier semantic
  // token (日本), causing churn on pass two. The unstripped input is
  // recognized SEPARATELY only to restore the region when stripping the sole
  // raw region alias would otherwise leave region null (the advisor's flag
  // case: raw 香港 01 with alias 香港 must keep its HK flag/region).
  // Route/vendor/rate/base always come from the stripped recognition.
  const recognizedBase = recognizeName(
    alias ? stripDelimited(recognitionName, alias) : recognitionName,
    config.recognitionRules,
  );
  const recognizedRaw = alias
    ? recognizeName(recognitionName, config.recognitionRules)
    : recognizedBase;
  const recognized = { ...recognizedBase, region: recognizedBase.region ?? recognizedRaw.region };

  const ctx: RenderContext = {};

  const flagCode =
    recognized.region &&
    (tokens.some((t) => t.type === 'field' && t.field === 'emoji') ||
      tokens.some((t) => t.type === 'optional' && t.field === 'emoji'))
      ? config.tw2cn && recognized.region === 'TW'
        ? 'CN'
        : recognized.region
      : null;
  if (flagCode) ctx.emoji = regionByCode(flagCode)?.emoji ?? flagFromCode(flagCode);
  if (recognized.region) {
    ctx.region = regionLabelFor(recognized.region, 'zh');
    ctx.regionCode = recognized.region;
  }

  const aliasCovers = (candidate: string | null): boolean =>
    alias !== null &&
    candidate !== null &&
    (alias === candidate || alias.toLowerCase() === candidate.toLowerCase());
  if (recognized.route && !aliasCovers(recognized.route)) ctx.route = recognized.route;
  if (recognized.entry && !aliasCovers(recognized.entry)) ctx.entry = recognized.entry;
  if (recognized.vendor && !aliasCovers(recognized.vendor)) ctx.vendor = recognized.vendor;
  if (opts.type && opts.type.trim() !== '') ctx.protocol = opts.type.trim();

  const rateText = recognized.rate !== null ? formatRate(recognized.rate) : null;
  if (recognized.rate !== null && !aliasCovers(rateText)) ctx.rate = rateText as string;

  // A purely-numeric residual (e.g. "香港 01") is almost always the node's
  // own ordinal — with the index placeholder rendering, it would double-count.
  // Drop it deterministically; anything with letters/words stays. Otherwise
  // strip a CLEARLY DELIMITED trailing source ordinal (≤3 digits after a
  // separator): "日本 Tokyo 01" → "Tokyo", so the generated index is the only
  // ordinal. Legitimate embedded numerics survive: "节点 2024" (4 digits),
  // "v2", "1.5x" (rate handled by its own placeholder), "Neo01" (no separator).
  let base = recognized.base;
  let upstreamOrdinal: number | null = null;
  if (usesIndex && opts.index !== undefined) {
    upstreamOrdinal = upstreamOrdinalOf(base);
    if (upstreamOrdinal !== null) {
      base = '';
    } else {
      base = base.replace(/[\s\-_·|:：]{1,4}\d{1,3}$/, '').trim();
    }
  }
  // POST-recognition alias strip: an already-present alias in the residual
  // base (a previously formatted name) is removed as a delimiter-bounded
  // component. Word-internal occurrences ("机场A号") are not separators and
  // survive. Raw names keep their semantic recognition because this runs
  // AFTER recognition, never before it.
  if (alias) {
    base = stripDelimited(base, alias);
  }

  if (alias) ctx.source = alias;
  if (base !== '') ctx.note = base;
  if (usesIndex && opts.index !== undefined) {
    const ordinal = upstreamOrdinal ?? opts.index;
    const width = Math.max(2, opts.indexWidth ?? 2);
    ctx.index = String(ordinal).padStart(width, '0');
  }

  const joined = renderTemplate(tokens, ctx);
  const withSuffix = collisionSuffix ? `${joined} ${collisionSuffix}`.trim() : joined;
  return withSuffix === '' ? name : withSuffix;
}

/* ─── executor (shared by every pipeline path) ─────────────────────── */

export interface TrueDedupEntry {
  /** Name kept (the winning node, per source priority). */
  kept: string;
  /** Name dropped — diagnostic provenance for the user/AI. */
  dropped: string;
  /** Source key of the dropped node, when known. */
  sourceKey?: string;
  /** Immutable raw identity of the kept node (binds diagnostics to identity). */
  keptFingerprint?: string;
  /** Immutable raw identity of the dropped node (binds diagnostics to identity). */
  droppedFingerprint?: string;
  /**
   * The exact RAW name + same-identity occurrence of the KEPT/DROPPED node
   * at dedup time (C9): a duplicate with a DIFFERENT raw name than its twin
   * must resolve to its own occurrence-exact opaque handle, never to the
   * first display-name match.
   */
  keptRawName?: string;
  keptOccurrence?: number;
  droppedRawName?: string;
  droppedOccurrence?: number;
}

export interface RenameTemplateApplyResult {
  proxies: Record<string, unknown>[];
  /** Nodes whose name changed. */
  changed: number;
  /**
   * Formatted names that collided and were disambiguated with a deterministic
   * meaningful suffix (source + stable index, then ` #N` on top) — surfaced
   * in the workbench preview.
   */
  collisions: string[];
  /**
   * Identity-bound collision diagnostics: for every collided formatted name,
   * the exact raw fingerprints + same-identity occurrences of the colliding
   * nodes — handles can be rebuilt occurrence-exactly without ever matching
   * a display name (C9).
   */
  collisionNodes: Array<{
    name: string;
    /**
     * EVERY participant of the collision (a formatted name with ≥2 final
     * candidates), each with its OWN final resolved name + identity
     * (rawName + fingerprint + occurrence — handle-capable, C9).
     */
    participants: Array<{
      resolvedTo: string;
      rawName: string;
      fingerprint: string;
      occurrence: number;
    }>;
  }>;
  /**
   * TRUE duplicates removed by node identity (server:port), never by display
   * name: same identity with different names dedups once per the explicit
   * source-priority policy (first source in input order wins); same name with
   * DIFFERENT identity always keeps both nodes.
   */
  deduped: TrueDedupEntry[];
}

/**
 * Server-only node identity: a canonical hash over the node's CONNECTION-
 * DEFINING config — type, server, port, credentials and protocol-specific
 * structural fields (UUID, cipher, SNI, ws-opts…). Two nodes on the same
 * endpoint with different configs are DIFFERENT nodes and both survive;
 * only an exact canonical match (same endpoint AND same credentials AND same
 * structure) is a true duplicate.
 *
 * The `name` field is excluded (it is display, not identity), and the hash is
 * computed with a pure-JS 64-bit FNV-style digest because this module is also
 * imported by client components (no node:crypto). The fingerprint never
 * leaves the server: it travels on an internal symbol and is stripped at
 * every serialization boundary. Nodes without a `server` field have no
 * fingerprint and are never identity-deduped (fail-open on missing identity).
 */

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function djb2_32(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic canonical serialization — key order can never matter. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable server-only fingerprint — same node ⇒ same hash, always. */
export function nodeFingerprint(proxy: unknown): string | null {
  if (!proxy || typeof proxy !== 'object') return null;
  const record = proxy as Record<string, unknown>;
  if (typeof record.server !== 'string' || record.server.trim() === '') return null;
  // `name` is display, not identity — excluded from the canonical hash.
  const identity: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'name') continue;
    identity[key] = value;
  }
  const canonical = canonicalJson(identity);
  const a = fnv1a32(canonical).toString(16).padStart(8, '0');
  const b = djb2_32(canonical).toString(16).padStart(8, '0');
  return `${a}${b}`;
}

/**
 * Server-only stable-numbering resolver: given a node and its source key,
 * return the PERSISTED ordinal assignment when one exists (undefined =
 * fall back to upstream ordinal / input order). Produced by
 * lib/services/nodeOrdinalService from the Redis assignment store; never
 * exposed to management or assistant payloads.
 */
export type OrdinalResolver = (proxy: unknown, sourceKey: string) => number | undefined;

/**
 * Run the rename-template over a proxy list. Deterministic + unique:
 *   - TRUE dedup by node identity (canonical config fingerprint): the first
 *     occurrence per source-priority order wins; dropped nodes are reported
 *     in `deduped`;
 *   - per-source ordinals resolve in this order: a PERSISTED server-side
 *     assignment (via `ordinalResolver`, monotonic non-reuse), then an
 *     unambiguous UPSTREAM ordinal ("香港 01" ⇒ 01), then input order — so
 *     upstream reordering does not churn already-assigned names;
 *   - EVERY duplicate final name gets a deterministic MEANINGFUL suffix
 *     (source label + stable index, then ` #N` on top), never a silent
 *     #N-only policy;
 *   - repeated execution over its own output is a no-op (idempotent).
 */
export function applyRenameTemplate(
  proxies: Record<string, unknown>[],
  config: RenameTemplateConfig,
  sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
  ordinalResolver?: OrdinalResolver,
): RenameTemplateApplyResult {
  // Identity + occurrence for EVERY raw node, computed ONCE (O(n)): both
  // the dedup and collision diagnostics below emit the exact raw-name
  // occurrence at the moment identity is known (C9). The occurrence counts
  // nodes with the SAME rawName+fingerprint pair — the identical key scheme
  // as namingActions.handleOf — so a diagnostic handle round-trips through
  // inspect_node_parse to the exact node, even for true duplicates whose raw
  // names differ from their twin's.
  const rawIdentityByIndex = new Map<number, { fp: string; rawName: string; occurrence: number }>();
  {
    const seenIdentityCount = new Map<string, number>();
    proxies.forEach((p, i) => {
      const fp = fingerprintOf(p) ?? nodeFingerprint(p);
      if (fp === null) return;
      // The IMMUTABLE envelope rawName (never the current display name — a
      // source-stage rename must not change the identity a collection-stage
      // handle round-trips with).
      const rawName =
        envelopeOf(p)?.rawName ?? (typeof p.name === 'string' ? (p.name as string) : '');
      const key = `${rawName}\x00${fp}`;
      const occurrence = seenIdentityCount.get(key) ?? 0;
      seenIdentityCount.set(key, occurrence + 1);
      rawIdentityByIndex.set(i, { fp, rawName, occurrence });
    });
  }

  // Pass 0 — true dedup by identity (canonical config fingerprint). First
  // occurrence wins (input order == source order == the documented
  // source-priority policy).
  const seenIdentity = new Map<string, number>();
  const deduped: TrueDedupEntry[] = [];
  const surviving: Array<{ proxy: Record<string, unknown>; index: number }> = [];
  proxies.forEach((p, i) => {
    // Identity is the IMMUTABLE raw fingerprint carried from the fetch
    // boundary when present (fallback: compute from the current object — the
    // documented path for envelope-less test inputs).
    const fp = fingerprintOf(p) ?? nodeFingerprint(p);
    if (fp === null) {
      surviving.push({ proxy: p, index: i });
      return;
    }
    const first = seenIdentity.get(fp);
    if (first === undefined) {
      seenIdentity.set(fp, i);
      surviving.push({ proxy: p, index: i });
      return;
    }
    const keptName = typeof proxies[first].name === 'string' ? (proxies[first].name as string) : '';
    const droppedName = typeof p.name === 'string' ? p.name : '';
    const keptIdentity = rawIdentityByIndex.get(first);
    const droppedIdentity = rawIdentityByIndex.get(i);
    deduped.push({
      kept: keptName,
      dropped: droppedName,
      sourceKey: sourceOfProxy(p)?.key,
      keptFingerprint: keptIdentity?.fp,
      droppedFingerprint: droppedIdentity?.fp,
      keptRawName: keptIdentity?.rawName,
      keptOccurrence: keptIdentity?.occurrence,
      droppedRawName: droppedIdentity?.rawName,
      droppedOccurrence: droppedIdentity?.occurrence,
    });
  });

  const list = surviving.map((s) => s.proxy);
  const usesIndex = templateUsesIndex(compileTemplateSafe(config.template));

  // Per-source ordinals (first pass): persisted assignment → unambiguous
  // upstream ordinal → input order. The width adapts to the LARGEST ordinal
  // in the source so reordering upstream never churns assigned names.
  const ordinalBySource = new Map<string, number>();
  const widthBySource = new Map<string, number>();
  const ordinalOf = (sourceKey: string): number => {
    const ordinal = (ordinalBySource.get(sourceKey) ?? 0) + 1;
    ordinalBySource.set(sourceKey, ordinal);
    return ordinal;
  };
  const ordinals = new Map<number, number>();
  list.forEach((p, i) => {
    const key = sourceOfProxy(p)?.key ?? '';
    let ordinal: number | null = null;
    // Priority: unambiguous UPSTREAM ordinal FIRST (stable, deterministic,
    // identical in preview/preflight/export/render — none of which can differ
    // on an upstream suffix), THEN the persisted server-side assignment, then
    // input order. The persisted assignment is exactly the input-order value
    // the FIRST serving render published, so read-only paths and the first
    // render agree on every node without any preview/preflight write.
    if (usesIndex) {
      const name = typeof p.name === 'string' ? p.name : '';
      if (name !== '') {
        const upstream = upstreamOrdinalOf(recognizeName(name, config.recognitionRules).base);
        if (upstream !== null && upstream > 0) ordinal = upstream;
      }
    }
    if (ordinal === null) {
      const resolved = ordinalResolver?.(p, key);
      if (typeof resolved === 'number' && Number.isInteger(resolved) && resolved > 0) {
        ordinal = resolved;
      }
    }
    if (ordinal === null) ordinal = ordinalOf(key);
    ordinals.set(i, ordinal);
    widthBySource.set(key, Math.max(widthBySource.get(key) ?? 0, String(ordinal).length));
  });

  const candidates: Array<{
    proxy: Record<string, unknown>;
    name: string;
    formatted: string;
    changed: boolean;
  }> = [];

  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    const name = typeof p.name === 'string' ? p.name : '';
    const source = sourceOfProxy(p);
    const key = source?.key ?? '';

    const formatted =
      name === ''
        ? ''
        : formatNodeName({
            name,
            type: typeof p.type === 'string' ? p.type : undefined,
            source: source ?? null,
            index: ordinals.get(i),
            indexWidth: Math.max(2, widthBySource.get(key) ?? 2),
            config,
          });
    candidates.push({ proxy: p, name, formatted, changed: name !== '' && formatted !== name });
  }

  // Deterministic uniqueness contract: the FINAL output has NO duplicate
  // names. Processing order:
  //   1. reserve the FIRST occurrence of every unchanged name (an unchanged
  //      node never gets displaced by a later changed node);
  //   2. assign changed candidates in input order, suffixing against the
  //      reserved set AND already-assigned finals;
  //   3. unchanged DUPLICATES (a second identical unchanged name) suffix the
  //      same way — the first occurrence keeps the plain name.
  // Disambiguation is MEANINGFUL: a collision prefers ` · sourceKey-index`
  // (source + stable index) and only falls back to ` #N` on top of it.
  const reserved = new Set<string>();
  const firstUnchanged = new Set<number>();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (c.name === '' || c.changed) continue;
    if (!reserved.has(c.formatted)) {
      reserved.add(c.formatted);
      firstUnchanged.add(i);
    }
  }

  const taken = new Set<string>(reserved);
  const collisions: string[] = [];
  const collisionNodes: Array<{
    name: string;
    participants: Array<{
      resolvedTo: string;
      rawName: string;
      fingerprint: string;
      occurrence: number;
    }>;
  }> = [];
  const finals = new Map<number, string>();
  let changed = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (c.name === '' || firstUnchanged.has(i)) continue;
    const source = sourceOfProxy(c.proxy);
    const sourceKey = source?.key;
    const sourceLabel = sourceKey
      ? (config.sourceAliases?.[sourceKey] ?? source?.label ?? null)
      : null;
    // The meaningful suffix is source label + the node's STABLE ordinal —
    // deterministic, human-readable, and unique per source+index. Only when
    // that still collides (equal labels across sources) does #N come on top.
    const ordinal = ordinals.get(i);
    const suffix =
      sourceLabel && ordinal !== undefined
        ? ` · ${sourceLabel}-${String(ordinal).padStart(Math.max(2, widthBySource.get(sourceKey ?? '') ?? 2), '0')}`
        : null;
    let final = c.formatted;
    let n = 2;
    while (taken.has(final)) {
      const meaningful = suffix ? `${c.formatted}${suffix}` : null;
      if (meaningful && !taken.has(meaningful)) {
        final = meaningful;
        break;
      }
      final = `${meaningful ?? c.formatted} #${n}`;
      n += 1;
    }
    if (final !== c.formatted) collisions.push(c.formatted);
    taken.add(final);
    finals.set(i, final);
    if (final !== c.name) changed += 1;
  }

  // ALL-PARTICIPANT collision diagnostics: every formatted name with ≥2
  // final candidates lists each participant with its own final resolved
  // name + raw identity (C9). Built from the raw identity map computed
  // BEFORE any transform — envelope rawName + fingerprint + occurrence.
  {
    const byFormatted = new Map<string, Array<{ index: number; proxy: Record<string, unknown> }>>();
    candidates.forEach((c, i) => {
      if (c.name === '') return;
      const list = byFormatted.get(c.formatted) ?? [];
      list.push({ index: i, proxy: c.proxy });
      byFormatted.set(c.formatted, list);
    });
    for (const [name, members] of byFormatted) {
      if (members.length < 2) continue;
      const proxyIndex = new Map<Record<string, unknown>, number>();
      proxies.forEach((p, i) => proxyIndex.set(p, i));
      const participants: Array<{
        resolvedTo: string;
        rawName: string;
        fingerprint: string;
        occurrence: number;
      }> = [];
      for (const member of members) {
        const rawIndex = proxyIndex.get(member.proxy) ?? -1;
        const identity = rawIndex >= 0 ? rawIdentityByIndex.get(rawIndex) : undefined;
        if (!identity) continue;
        const finalName = finals.get(member.index) ?? member.proxy.name;
        participants.push({
          resolvedTo: typeof finalName === 'string' ? finalName : '',
          rawName: identity.rawName,
          fingerprint: identity.fp,
          occurrence: identity.occurrence,
        });
      }
      if (participants.length > 0) collisionNodes.push({ name, participants });
    }
  }

  const out: Record<string, unknown>[] = candidates.map((c, i) => {
    if (c.name === '' || firstUnchanged.has(i)) return c.proxy;
    return { ...c.proxy, name: finals.get(i)! };
  });
  return { proxies: out, changed, collisions, collisionNodes, deduped };
}

function compileTemplateSafe(template: string): TemplateToken[] {
  try {
    return compileTemplate(template);
  } catch {
    return [];
  }
}

/* ─── legacy compatibility projection ──────────────────────────────── */

/** Legacy (pre-DSL) rename-template persisted shape — decode only. */
export interface LegacyRenameTemplateConfig {
  preset: string;
  components: {
    flag: boolean;
    region: boolean;
    route: boolean;
    vendor: boolean;
    protocol: boolean;
    rate: boolean;
    source: boolean;
    index: boolean;
  };
  regionLabel: 'zh' | 'code';
  rateDisplay: 'omit-1x' | 'all';
  separator: ' ' | ' · ' | ' | ';
}

/** Legacy balanced default components (single-subscription orientation). */
export const LEGACY_DEFAULT_COMPONENTS = {
  flag: true,
  region: true,
  route: true,
  vendor: false,
  protocol: false,
  rate: true,
  source: false,
  index: true,
} as const;

/**
 * Deterministic compatibility projection from the legacy preset/component/
 * separator shape to an equivalent placeholder template. Flag + region become
 * one visual block with a normal space (the redesigned default look); the
 * legacy separator is preserved BETWEEN the remaining components; every other
 * field maps to an optional segment so missing fields leave no dangling
 * separators. `note` (the residual fragment) is included because legacy
 * naming always kept the residual base.
 */
export function templateFromLegacyConfig(legacy: LegacyRenameTemplateConfig): string {
  const sep = legacy.separator;
  const block: string[] = [];
  if (legacy.components.flag) block.push('${emoji}');
  if (legacy.components.region) {
    block.push(legacy.regionLabel === 'code' ? '${region_code}' : '${region}');
  }
  const parts: string[] = [];
  if (block.length > 0) parts.push(block.join(' '));
  const optional = (
    field: 'route' | 'vendor' | 'protocol' | 'rate' | 'note' | 'source' | 'index',
    enabled: boolean,
  ): void => {
    if (!enabled) return;
    if (field === 'rate') {
      const placeholder =
        legacy.rateDisplay === 'all'
          ? '${?rate:' + sep + '${rate:include1x}}'
          : '${?rate:' + sep + '${rate}}';
      parts.push(placeholder);
      return;
    }
    // The separator lives INSIDE the optional content: when the field is
    // missing the whole segment (separator included) disappears — no
    // dangling separator can survive.
    parts.push('${?' + field + ':' + sep + '${' + field + '}}');
  };
  optional('route', legacy.components.route);
  optional('vendor', legacy.components.vendor);
  optional('protocol', legacy.components.protocol);
  optional('rate', legacy.components.rate);
  optional('note', true); // legacy always kept the residual base
  optional('source', legacy.components.source);
  optional('index', legacy.components.index);
  // REQUIRED-content guarantee: a valid legacy row (e.g. every component off,
  // or only route on) must project to an ACTIVE, valid template — never an
  // optional-only string that would silently disable the step. The FIRST
  // legacy-rendered field becomes required: legacy composed it unconditionally
  // when present (all-off ⇒ only the residual base, i.e. `${note}`).
  if (parts.length === 0) return '${note}';
  if (parts.every((part) => part.startsWith('${?'))) {
    const first = parts.shift() as string;
    const field = /^\$\{\?([a-z_]+):/.exec(first)?.[1] ?? 'note';
    parts.unshift('${' + field + '}');
  }
  return parts.join('');
}

/** The exact projection of the legacy balanced preset — used by tests. */
export const LEGACY_BALANCED_TEMPLATE = templateFromLegacyConfig({
  preset: 'balanced',
  components: { ...LEGACY_DEFAULT_COMPONENTS },
  regionLabel: 'zh',
  rateDisplay: 'omit-1x',
  separator: ' · ',
});
