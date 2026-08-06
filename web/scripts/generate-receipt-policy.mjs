#!/usr/bin/env node
/**
 * Receipt policy generator — the ONLY writer of
 *   web/lib/ai/receiptPolicy.generated.ts        (Web producer scanner)
 *   plugin/servers/receipt-policy.generated.mjs  (MCP verifier scanner)
 *
 * Both outputs embed the SAME policy: the spec's version, the SHA-256 of the
 * canonical policy text (RECEIPT_POLICY_HASH), the raw/canonical bounds, the
 * residue vocabulary, the ordered semantic span table (with the generator-
 * assembled case-insensitive sensitive-next alternations), and the identical
 * scanner functions:
 *   - replaceReceiptControls(value)          — every Unicode Cc/Cf → one space
 *   - removeReceiptSpans(value, opContext)   — ordered span removal (opaque24
 *                                             skipped in op context)
 *   - hasMeaningfulResidue(value)
 *   - canonicalizeReceiptText(raw, rawBound, opContext)  — Web producer path
 *   - isCanonicalReceiptSummary(summary)     — MCP already-canonical check
 *
 * `--check` regenerates both modules in memory, compares their bytes with the
 * on-disk files AND the embedded policy hash/version, and exits 0 (fresh) or
 * 1 (stale) WITHOUT writing anything.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CJK_IDN_TLDS,
  RECEIPT_OP_MAX,
  RECEIPT_OP_RAW_MAX,
  RECEIPT_PATTERNS,
  RECEIPT_POLICY_SOURCE,
  RECEIPT_POLICY_VERSION,
  RECEIPT_SUMMARY_MAX,
  RECEIPT_SUMMARY_RAW_MAX,
  RESIDUE_VOCABULARY,
  SENSITIVE_KEYS,
} from './receipt-policy-spec.mjs';

const WEB_OUT = fileURLToPath(new URL('../lib/ai/receiptPolicy.generated.ts', import.meta.url));
const MCP_OUT = fileURLToPath(
  new URL('../../plugin/servers/receipt-policy.generated.mjs', import.meta.url),
);

/** Case-fold a word into a case-insensitive character-class alternation. */
function fold(word) {
  let out = '';
  for (const ch of word) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    out += lo === up ? ch : `[${lo}${up}]`;
  }
  return out;
}

/** The case-insensitive sensitive-next alternation (schemes + sk- + keys). */
const SCHEME_NEXT = ['Bearer', 'Basic', 'Token'].map(fold).join('|');
const KEYS = SENSITIVE_KEYS.join('|');
const KEYS_FOLDED = SENSITIVE_KEYS.map(fold).join('|');
// sk- and every key are case-folded too: the enclosing scheme/key regexes
// run without the /i flag, so the tail lookahead must match "SK-FAKE",
// "PASSWORD=x" etc. by construction. Schemes and keys get a word boundary;
// the `sk-` alternative ends in a non-word char, so it must stay
// boundary-free (a trailing \b after '-' would fail at EOS or before
// punctuation).
const SENSITIVE_NEXT = `(?:(?:${SCHEME_NEXT}|${KEYS_FOLDED})\\b|[sS][kK]-)`;

/** Build the compiled ordered span table (validates every pattern now). */
function buildSpans() {
  return RECEIPT_PATTERNS.map((entry) => {
    const source = entry.re
      .replaceAll('{CJK_IDN_TLDS}', CJK_IDN_TLDS)
      .replaceAll('{SCHEME_NEXT}', SCHEME_NEXT)
      .replaceAll('{SENSITIVE_NEXT}', SENSITIVE_NEXT)
      .replaceAll('{KEYS}', KEYS)
      .replaceAll('{KEYS_FOLDED}', KEYS_FOLDED);
    const regex = new RegExp(source, entry.flags ?? 'g');
    return {
      name: entry.name,
      re: regex,
      flags: regex.flags,
      opContext: entry.opContext !== false,
    };
  });
}

const SPANS = buildSpans();
const SPAN_NAMES = SPANS.map((s) => s.name);

/**
 * Policy attestation: the hash covers EVERY behavior-bearing input of the
 * generated module — version, the canonical policy text, both raw bounds,
 * both canonical bounds, the residue vocabulary, and the FULLY EXPANDED
 * ordered span table (name, final compiled regex source, final flags,
 * op-context behavior) — so any behavioral change in the spec OR the
 * generator's folding/boundary assembly changes the embedded hash and
 * `--check` fails.
 */
const POLICY_HASH = createHash('sha256')
  .update(
    JSON.stringify({
      version: RECEIPT_POLICY_VERSION,
      source: RECEIPT_POLICY_SOURCE,
      opRawMax: RECEIPT_OP_RAW_MAX,
      summaryRawMax: RECEIPT_SUMMARY_RAW_MAX,
      opMax: RECEIPT_OP_MAX,
      summaryMax: RECEIPT_SUMMARY_MAX,
      vocabulary: RESIDUE_VOCABULARY,
      keys: SENSITIVE_KEYS,
      tlds: CJK_IDN_TLDS,
      spans: SPANS.map((s) => ({
        name: s.name,
        source: s.re.source,
        flags: s.flags,
        opContext: s.opContext,
      })),
    }),
  )
  .digest('hex');

/**
 * Render a multi-line, trailing-comma string array literal — the layout
 * Prettier itself emits (web/.prettierrc for the TS module, the default
 * config for the MJS module), so both generated modules are Prettier-clean
 * deterministically without any external formatter dependency.
 */
function renderStringList(items, q) {
  return `[\n${items.map((item) => `  ${q}${item}${q},`).join('\n')}\n]`;
}

/**
 * Shared body template. `$Q$` is the per-language quote character ("' for
 * the TS module under web/.prettierrc, '"' for the MJS module under the
 * default config); `$VOCAB_LIST$` / `$SPAN_NAMES_LIST$` are the rendered
 * multi-line list literals. Regex literals keep their own quotes and are
 * never touched by the substitution.
 */
const BODY_TEMPLATE = `
const RESIDUE_VOCABULARY = new Set($VOCAB_LIST$);

/** Ordered semantic span regexes (compiled once at module load). */
const RECEIPT_SPANS = [
${SPANS.map((s) => `  /${s.re.source}/${s.re.flags},`).join('\n')}
];
const RECEIPT_SPAN_NAMES = $SPAN_NAMES_LIST$;
/** Span names skipped when canonicalizing in op context (length-based
 * opaque classification must never erase a valid long lower-kebab op). */
const OP_CONTEXT_SKIP = new Set([$Q$opaque24$Q$]);

/** Every Unicode Cc/Cf code point becomes ONE nonjoining separator. */
export function replaceReceiptControls(value) {
  return value.replace(/\\p{Cc}|\\p{Cf}/gu, $Q$ $Q$);
}

/** Remove every semantic sensitive span; each span becomes ONE space. */
export function removeReceiptSpans(value, opContext) {
  let out = value;
  for (let i = 0; i < RECEIPT_SPANS.length; i += 1) {
    if (opContext && OP_CONTEXT_SKIP.has(RECEIPT_SPAN_NAMES[i])) continue;
    out = out.replace(RECEIPT_SPANS[i], $Q$ $Q$);
  }
  return out;
}

/**
 * True when the text contains at least one Unicode letter-or-number token
 * that is NOT a residue-vocabulary word (case-folded).
 */
export function hasMeaningfulResidue(value) {
  const tokens = value.split(/[^\\p{L}\\p{N}]+/u).filter((token) => token !== $Q$$Q$);
  return tokens.some((token) => {
    if (!/[\\p{L}\\p{N}]/u.test(token)) return false;
    return !RESIDUE_VOCABULARY.has(token.toLocaleLowerCase($Q$en$Q$));
  });
}

/**
 * Web producer canonicalization: raw UTF-16 bound BEFORE any normalization
 * (never slice), NFKC, Cc/Cf separators, ordered span removal, whitespace
 * collapse, then the meaningful-residue rule. Returns null when nothing
 * safe and meaningful remains — the caller yields the fixed unknown.
 * opContext skips the opaque-24 span so a valid long lower-kebab op is
 * never classified opaque merely by length.
 */
export function canonicalizeReceiptText(raw, rawBound, opContext) {
  if (typeof raw !== $Q$string$Q$) return null;
  if (raw.length > rawBound) return null;
  let cleaned = raw.normalize($Q$NFKC$Q$);
  cleaned = replaceReceiptControls(cleaned);
  cleaned = removeReceiptSpans(cleaned, opContext === true);
  cleaned = cleaned.replace(/\\s+/g, $Q$ $Q$).trim();
  if (cleaned === $Q$$Q$) return null;
  if (!hasMeaningfulResidue(cleaned)) return null;
  return cleaned;
}

/**
 * MCP verifier check: the summary must ALREADY be canonical — NFKC identity,
 * no Cc/Cf controls, no span removal, no whitespace collapse, meaningful
 * residue, and within the raw + canonical bounds.
 */
export function isCanonicalReceiptSummary(summary) {
  if (typeof summary !== $Q$string$Q$ || summary === $Q$$Q$) return false;
  if (summary.length > RECEIPT_SUMMARY_RAW_MAX) return false;
  if (summary.length > RECEIPT_SUMMARY_MAX) return false;
  if (summary.normalize($Q$NFKC$Q$) !== summary) return false;
  const withSeparators = replaceReceiptControls(summary);
  if (withSeparators !== summary) return false;
  const afterSpans = removeReceiptSpans(withSeparators, false);
  if (afterSpans !== summary) return false;
  const collapsed = afterSpans.replace(/\\s+/g, $Q$ $Q$).trim();
  if (collapsed !== afterSpans) return false;
  return hasMeaningfulResidue(collapsed);
}
`;

function renderBody(q) {
  return BODY_TEMPLATE.replaceAll('$VOCAB_LIST$', renderStringList([...RESIDUE_VOCABULARY], q))
    .replaceAll('$SPAN_NAMES_LIST$', renderStringList(SPAN_NAMES, q))
    .replaceAll('$Q$', q);
}

function renderBodyTs() {
  return renderBody("'")
    .replace(
      'export function replaceReceiptControls(value) {',
      'export function replaceReceiptControls(value: string): string {',
    )
    .replace(
      'export function removeReceiptSpans(value, opContext) {',
      'export function removeReceiptSpans(value: string, opContext: boolean): string {',
    )
    .replace(
      'export function hasMeaningfulResidue(value) {',
      'export function hasMeaningfulResidue(value: string): boolean {',
    )
    .replace(
      'export function canonicalizeReceiptText(raw, rawBound, opContext) {',
      'export function canonicalizeReceiptText(\n  raw: unknown,\n  rawBound: number,\n  opContext?: boolean,\n): string | null {',
    )
    .replace(
      'export function isCanonicalReceiptSummary(summary) {',
      'export function isCanonicalReceiptSummary(summary: unknown): boolean {',
    )
    .replace('const RESIDUE_VOCABULARY = new Set(', 'const RESIDUE_VOCABULARY = new Set<string>(')
    .replace('const RECEIPT_SPAN_NAMES = ', 'const RECEIPT_SPAN_NAMES: string[] = ')
    .replace('const OP_CONTEXT_SKIP = new Set(', 'const OP_CONTEXT_SKIP = new Set<string>(');
}

function renderHeader(q) {
  return `/**
 * GENERATED FILE — DO NOT EDIT.
 * Canonical receipt policy generated by web/scripts/generate-receipt-policy.mjs
 * from web/scripts/receipt-policy-spec.mjs. Manual spec + policy text live
 * ONLY in web/scripts/receipt-policy-spec.mjs; run the generator (or
 * \`node web/scripts/generate-receipt-policy.mjs --check\` to verify).
 */

export const RECEIPT_POLICY_VERSION = ${RECEIPT_POLICY_VERSION};
export const RECEIPT_POLICY_HASH =
  ${q}${POLICY_HASH}${q};
export const RECEIPT_OP_RAW_MAX = ${RECEIPT_OP_RAW_MAX};
export const RECEIPT_SUMMARY_RAW_MAX = ${RECEIPT_SUMMARY_RAW_MAX};
export const RECEIPT_OP_MAX = ${RECEIPT_OP_MAX};
export const RECEIPT_SUMMARY_MAX = ${RECEIPT_SUMMARY_MAX};
`;
}

function renderModule(lang) {
  if (lang === 'ts') {
    return `${renderHeader("'")}${renderBodyTs()}`;
  }
  return `${renderHeader('"')}${renderBody('"')}`;
}

function renderAll() {
  return { ts: renderModule('ts'), mjs: renderModule('mjs') };
}

function main() {
  const check = process.argv.includes('--check');
  const rendered = renderAll();
  const readOpt = (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  const onDisk = { ts: readOpt(WEB_OUT), mjs: readOpt(MCP_OUT) };
  const tsFresh = onDisk.ts === rendered.ts;
  const mjsFresh = onDisk.mjs === rendered.mjs;
  if (check) {
    // embedded policy hash/version are part of the module bytes; comparing
    // the full bytes covers them, and we still state the hash for the log
    if (tsFresh && mjsFresh) {
      console.log(
        `receipt policy fresh · version ${RECEIPT_POLICY_VERSION} · hash ${POLICY_HASH} · ts=${WEB_OUT} mjs=${MCP_OUT}`,
      );
      process.exit(0);
    }
    console.error(`receipt policy STALE · version ${RECEIPT_POLICY_VERSION} · hash ${POLICY_HASH}`);
    if (!tsFresh) console.error(`  ts differs: ${WEB_OUT}`);
    if (!mjsFresh) console.error(`  mjs differs: ${MCP_OUT}`);
    process.exit(1);
  }
  writeFileSync(WEB_OUT, rendered.ts);
  writeFileSync(MCP_OUT, rendered.mjs);
  console.log(
    `generated receipt policy v${RECEIPT_POLICY_VERSION} hash ${POLICY_HASH} → ${WEB_OUT}, ${MCP_OUT}`,
  );
}

main();
