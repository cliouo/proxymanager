import { FIXED_MIHOMO_PROXY_TYPES } from './mihomoProxyValidator';

/**
 * Credential-free AI payload construction for the naming-analysis feature.
 *
 * Raw node names can embed credential-like text (URLs, emails, IPv4/IPv6,
 * UUIDs, tokens, host:port, query strings). Before anything derived from a
 * name may leave for a model provider, the residual fragment must pass
 * explicit redaction, be truncated to a bounded length, and — when nothing
 * survives — be dropped entirely.
 *
 * Pure + isomorphic: the same code runs in tests and in the server-side
 * analysis route, so "redacted" has exactly one definition.
 */

/**
 * Ordered redaction patterns. Each removes a whole credential-shaped span so
 * the residue cannot reassemble into a readable secret. Kept deliberately
 * conservative: false positives only shorten a display fragment.
 */
/**
 * Bounded CJK IDN TLDs — 例子.中国 / 中文.香港.公司 are real hostnames, while
 * ordinary dotted Chinese text (香港.中转) must stay intact, so the TLD set is
 * explicit, not "any 2+ letters".
 */
const CJK_IDN_TLDS =
  '中国|香港|台湾|台灣|公司|网络|網絡|在线|在線|商城|网址|網址|商店|政务|政務|公益|集团|集團|游戏|遊戲|商标|商標|移动|移動|联通|聯通|中信|みんな|コム|世界|企业|企業|娱乐|娛樂|新闻|新聞|购物|購物';

/**
 * Endpoint tokens are redacted WHOLE — host, port, zone and brackets in one
 * atomic match — so no `:443` / `[ ]` / `%eth0` residue can survive into a
 * sanitized fragment. Order matters: the more specific whole-token forms run
 * first; `(?!\.\d)` keeps a consumed port from being a prefix of a dotted
 * remainder.
 */
const REDACTION_PATTERNS: ReadonlyArray<RegExp> = [
  // full URLs (scheme://…), incl. userinfo
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
  // bracketed endpoint: [host|IPv6|zone](:port)? — e.g. [::1]:443,
  // [2001:db8::1]:8443, [fe80::1%eth0]:443, [example.com]:8443
  /\[[^\s"'<>]{1,64}\](?::\d{1,5})?/gi,
  // `::`-compressed IPv6 with port (leading or middle compression), optional
  // zone: 2001:db8::1:8443, ::1:443, fe80::1%eth0:443
  /\b(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?:%[A-Za-z0-9._-]{1,32})?:\d{1,5}(?!\.\d)\b/gi,
  // full-hextet IPv6 with port: 2001:db8:1:2:3:4:5:6:443
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){1,7}:\d{1,5}(?!\.\d)\b/gi,
  // IPv4-mapped / IPv4-compatible IPv6 — atomic dotted tail so no `.2.3.4`
  // residue survives, with an optional trailing port. Two forms: with a
  // leading hextet group (2001:db8::ffff:1.2.3.4, 2001:db8::192.0.2.1:443 —
  // `\b`-anchored) and starting at `::` (::ffff:1.2.3.4, ::192.0.2.1:443 —
  // lookbehind-anchored, since `\b` cannot start on a colon).
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}::(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5}(?!\.\d))?\b/gi,
  /(?<=^|[^0-9A-Za-z:])::(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5}(?!\.\d))?(?![0-9A-Za-z])/gi,
  // IPv6 with a TRAILING `::` and no tail (2001:db8::, fe80::) — the leading
  // part must be pure hex so `v1::beta`-style version tokens never match, and
  // the lookahead keeps `2001:db8::1` for the required-tail pattern below.
  // Runs BEFORE the plain hextet form so a trailing-`::` token is never
  // partially eaten by it.
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}::(?![0-9A-Za-z])/gi,
  // IPv6 — `::`-compressed with leading group and a REQUIRED multi-hextet
  // tail (2001:db8::abcd:ef01). The required tail is what keeps version
  // tokens like `v1::beta` intact — no trailing-empty match is possible. The
  // `(?!\.\d)` guards stop a colon-group from eating the start of a mapped
  // tail (`::ffff:1.2.3.4` → `:1` must not be consumed as a hextet).
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\.\d)){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\.\d)){0,6})\b/gi,
  // IPv6 with OMITTED leading groups — bare `::1` and equivalent `::`-leading
  // forms (::x, ::x:y…), optional IPv4-mapped tail (guard same as above).
  // Lookbehind/lookahead keep `v1::beta` style version tokens and `::` alone
  // intact; `::1x` (hex followed by a letter) is left alone as not-a-
  // credible-address.
  /(?<=^|[^0-9A-Za-z:])(?:::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\.\d)){0,6})(?::\d{1,3}(?:\.\d{1,3}){3})?(?![0-9A-Za-z])/gi,
  // bare IPv4:port — MUST run BEFORE the plain IPv6 hextet pattern: the
  // 2-hextet heuristic matches "10:8443", so an unguarded ordering would
  // partially eat "192.0.2.10:8443" and leave a "192.0.2."-style residue.
  // The WHOLE IPv4:port token is consumed here first.
  /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}(?!\.\d)\b/gi,
  // IPv6 — full hextet form, 2+ groups. Runs AFTER every `::` form so
  // compressed tokens are consumed whole first, and also closes bare
  // 2-hextet fragments such as "2001:db8" that survive separator tidying.
  // The `(?!\.\d)` guard (same as its siblings) stops a colon-group from
  // partially eating a dotted IPv4 remainder.
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\.\d)){1,7}\b/gi,

  /\b(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+(?:xn--[a-z0-9-]{2,20}|[a-z]{2,}):\d{1,5}(?!\.\d)\b/gi,
  new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:[\\p{L}\\p{N}_]{1,63}\\.)+(?:${CJK_IDN_TLDS}):\\d{1,5}(?!\\.\\d)(?![\\p{L}\\p{N}_])`,
    'giu',
  ),
  // single-label host:port (myhost:443) — a letter-led token so version-ish
  // `1:2` forms survive
  /\b[a-z][a-z0-9-]{0,31}:\d{1,5}(?!\.\d)\b/gi,
  // IPv4
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  // IPv6 zone residue (fe80::1%eth0 → the address is eaten above, the zone here)
  /%[A-Za-z][A-Za-z0-9._-]{0,31}/gi,
  // emails — WHOLE token incl. punycode/Unicode hosts (BEFORE bare hostname
  // patterns, which would otherwise split the host and leave local-part or
  // TLD residue: user@example.xn--fiqs8s, user@例子.中国)
  /\b[A-Za-z0-9._%+-]{1,64}@(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+(?:xn--[a-z0-9-]{2,20}|[a-z]{2,})\b/gi,
  new RegExp(
    `(?<![\\p{L}\\p{N}_])[\\p{L}\\p{N}._%+-]{1,64}@(?:[\\p{L}\\p{N}_]{1,63}\\.)+(?:${CJK_IDN_TLDS})(?![\\p{L}\\p{N}_])`,
    'giu',
  ),
  // bare DNS hostname / SNI without a port — dotted label sequences ending in
  // a real-hostname TLD: ASCII (any ≥2-letter TLD or a punycode xn-- TLD),
  // with optional leading-underscore service labels (_svc._tcp.example.com).
  // Whole token: no finite TLD list, no partial labels left behind.
  /\b(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+(?:xn--[a-z0-9-]{2,20}|[a-z]{2,})\b/gi,
  // Unicode IDN without a port (例子.中国, 中文.香港.公司) — bounded CJK-IDN
  // TLD list so ordinary dotted Chinese text (e.g. "香港.中转") stays intact.
  new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:[\\p{L}\\p{N}_]{1,63}\\.)+(?:${CJK_IDN_TLDS})(?![\\p{L}\\p{N}_])`,
    'giu',
  ),
  // UUIDs
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5]?[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  // long base64-ish / hex key material (≥ 24 chars)
  /\b[A-Za-z0-9+/_-]{24,}\b/g,
  // bearer / api keys / secrets
  /\b(?:bearer|authorization|api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|psk|uuid|sn|host|sni|header)[=:]\s*[^\s"'<>]+/gi,
  // query strings (?a=b&c=d, &a=b, or a leading bare key=value)
  /[?&][A-Za-z0-9._-]{1,64}=[^&\s"'<>]{0,128}/g,
  /(?:^|\s)[A-Za-z0-9._-]{1,64}=[^&\s"'<>]{0,128}/g,
  // uuid-like bare hex run
  /\b[0-9a-f]{32}\b|\b[0-9a-f]{16}\b/gi,
];

/** Upper bound on a fragment that may be sent to a model provider. */
export const NAME_FEATURE_FRAGMENT_MAX = 24;

/**
 * Remove every credential-shaped span from `text`. The result is still
 * bounded by the caller (fragments are truncated afterwards).
 */
export function redactSensitiveText(text: string): string {
  let out = text;
  for (const re of REDACTION_PATTERNS) {
    out = out.replace(re, ' ');
  }
  return out;
}

/**
 * Sanitize a residual name fragment for the AI payload: redact → collapse
 * whitespace → truncate → drop when empty. Returns null when nothing safe
 * remains (the model then sees the component as absent, never a placeholder
 * that could look like data).
 */
export function sanitizeFragment(fragment: string): string | null {
  const redacted = redactSensitiveText(fragment).replace(/\s+/g, ' ').trim();
  if (redacted === '') return null;
  return redacted.slice(0, NAME_FEATURE_FRAGMENT_MAX);
}

/**
 * True when a candidate string still contains a credential-shaped span.
 * The analysis route re-checks every string field of its incoming payload
 * with this before anything reaches the model — defense in depth against a
 * future caller that forgets to sanitize.
 *
 * `.test()` on a /g regex advances lastIndex (stateful), so every check uses
 * a fresh stateless copy — same definition as the redaction itself.
 */
export function containsSensitivePattern(text: string): boolean {
  return REDACTION_PATTERNS.some((re) => {
    const stateless = re.flags.includes('g')
      ? new RegExp(re.source, re.flags.replace('g', ''))
      : re;
    return stateless.test(text);
  });
}

/**
 * Closed canonical proxy-protocol allowlist at the privacy boundary
 * (pass-7 blocker 5): the SINGLE authoritative set lives in the production
 * fetch validator (FIXED_MIHOMO_PROXY_TYPES) and is imported here — there is
 * exactly ONE manual list in the repository, never a second copy to drift.
 * Anything outside it is NOT canonical and must be rejected or keyed-tokenized.
 */
export const CANONICAL_PROXY_TYPES: ReadonlySet<string> = FIXED_MIHOMO_PROXY_TYPES;

/** Canonical protocol when the value is in the allowlist, else null. */
export function canonicalProxyType(value: unknown): string | null {
  return typeof value === 'string' && CANONICAL_PROXY_TYPES.has(value) ? value : null;
}
