#!/usr/bin/env node
/**
 * RECEIPT POLICY SPEC — the single canonical manual source for the confirmed-
 * write receipt policy. The generator (generate-receipt-policy.mjs) embeds
 * this spec's policy text and pattern table into BOTH runtimes:
 *   web/lib/ai/receiptPolicy.generated.ts        (Web producer)
 *   plugin/servers/receipt-policy.generated.mjs  (MCP verifier)
 *
 * There is exactly ONE manual policy in the repository; the generated
 * modules are byte-derivatives and `--check` proves they are fresh.
 *
 * ── Formal boundary contract ─────────────────────────────────────────────
 * For an originating action `a`, the Web producer W_a(E) returns only the
 * fixed unknown marker or the exact pair
 *   UI = { kind: 'write-result', data: { op, summary, events } } and
 *   M  = JSON.stringify({ status: 'success', action: a, summary }),
 * after RAW bounds (op ≤ 256, summary ≤ 2048 UTF-16 units — applied BEFORE
 * any normalization) and CANONICAL bounds (lower-kebab op 1..64, summary
 * 1..512 — EXCEEDING rejects, never truncates). The MCP verifiers V_s and
 * V_b are byte-identical, accept the exact Web-produced canonical M
 * unchanged, and fixed-unknown-reject wrong actions, every raw summary the
 * Web would change or reject, every hostile record, and every noncanonical
 * byte form of the JSON wire.
 *
 * ── Canonicalization ─────────────────────────────────────────────────────
 * 1. NFKC-normalize the raw text;
 * 2. every Unicode Cc or Cf code point becomes ONE nonjoining separator;
 * 3. remove every semantic sensitive span (below), each span → ONE space;
 * 4. collapse whitespace runs to single spaces and trim;
 * 5. reject when nothing remains or only residue vocabulary remains.
 *
 * ── Semantic span policy (ORDERED — longer/more specific forms first) ───
 *  - full URLs (scheme://… incl. userinfo and query) — whole span;
 *  - endpoint tokens: bracketed [host|IPv6|zone](:port), `::`-compressed
 *    IPv6 with port, full-hextet IPv6 with port, IPv4-mapped/compatible
 *    IPv6, trailing-`::` IPv6, compressed IPv6 with required tail,
 *    `::`-leading IPv6, IPv4:port, full-hextet IPv6 (2+ groups, at least
 *    one letter — digit-only "1:2" version forms survive), DNS hostname
 *    :port (ASCII + bounded CJK IDN), single-label host:port (letter-led),
 *    bare IPv4, IPv6 zone residue, emails, bare DNS hostnames, CJK IDN
 *    hostnames;
 *  - Authorization + Bearer/Basic/Token clause: optional `Authorization`
 *    with `:`/`=`, then a capitalized scheme with (a) an attached payload
 *    via `:`/`=`/`,`/`;`/`|`/brackets (any length incl. empty), (b) a
 *    whitespace-separated payload token that ends the text or is followed
 *    by another sensitive token, or (c) a bare scheme that ends the text
 *    or is followed by another scheme. All-caps scheme forms match the
 *    same three shapes. Ordinary lowercase words after a capitalized
 *    scheme ("Bearer service updated", "Basic plan enabled") never match;
 *  - `sk-` + maximal ASCII alnum/_/- suffix (incl. zero length), only at a
 *    non-word boundary;
 *  - JWT (three bounded base64url segments) and UUIDs — whole spans;
 *  - 16- and 32-hex uuid-like runs; opaque 24+ single tokens — EXCEPT in
 *    op context, where a valid lower-kebab op is never classified opaque
 *    merely by length (an actual sensitive span still removes);
 *  - sensitive key/value clauses — the exact keys password, passwd, pwd,
 *    secret, token, api-key variants (api_key/api-key/apikey), access-key
 *    variants (access_key/access-key/accesskey), auth, authorization,
 *    credential, uuid, sni, host, key, psk, code, signature, sig, op,
 *    cookie, cookies, header, headers, private-key variants
 *    (private_key/private-key/privatekey), session, csrf, endpoint, url —
 *    with (a) `:`/`=` + any payload (incl. empty), (b) a whitespace payload
 *    that contains a non-lowercase char and ends the text or precedes
 *    another sensitive token, or (c) a bare key at end of text; the key
 *    boundary consumes one preceding non-word delimiter;
 *  - redaction placeholders — `[redacted]`/`[masked]`/`[removed]` whole
 *    incl. brackets;
 *  - query strings (?a=b&c=d, &a=b) and generic `key=value` clauses.
 *
 * ── Residue rule ────────────────────────────────────────────────────────
 * A canonical op/summary must contain at least one Unicode letter-or-number
 * token that is NOT a residue vocabulary word (bearer, basic, token,
 * authorization, api, key, sk, uuid, http, https, url, redacted, masked,
 * removed, secret, credential) — credential-only/dominated text fails
 * closed. Removed spans become one separator; changed text collapses to
 * single spaces; empty or vocabulary-only residue rejects.
 *
 * ── Ordinary safe controls ──────────────────────────────────────────────
 * The exact fifteen safe fixtures — "Updated node", "Updated token
 * refresh", "Basic plan enabled", "Bearer service updated", "Version 1:2
 * unchanged", "Node renamed successfully", "规则已更新", "订阅源已刷新",
 * "Proxy group reordered", "设置已保存", "Filter updated for HK",
 * "香港 01 已重命名", "Deleted obsolete rule", "缓存已清理",
 * "Profile switched to default" — survive byte-identically.
 */

/** Bump on any behavioral policy change; embedded in both generated modules. */
export const RECEIPT_POLICY_VERSION = 1;

/** The canonical policy text — its SHA-256 is the embedded RECEIPT_POLICY_HASH. */
export const RECEIPT_POLICY_SOURCE = `
Canonical receipt policy v1.
Bounds: raw op <= 256 and raw summary <= 2048 UTF-16 units, checked before any normalization; canonical op is lower-kebab 1..64 and canonical summary 1..512, exceeding rejects.
Normalization: NFKC first; every Unicode Cc/Cf code point becomes one nonjoining separator; whitespace runs collapse to single spaces; leading/trailing whitespace trims.
Spans (ordered, case per form, each replaced by one space): full URLs incl userinfo and query; endpoint tokens (bracketed host/IPv6/zone with optional port, ::-compressed IPv6 with port, full-hextet IPv6 with port, IPv4-mapped/compatible IPv6, trailing-:: IPv6, compressed IPv6 with required tail, ::-leading IPv6, IPv4:port, full-hextet IPv6 with at least one letter, DNS hostname:port incl bounded CJK IDN, letter-led single-label host:port, bare IPv4, IPv6 zone residue, emails, bare DNS hostnames, CJK IDN hostnames); Authorization plus Bearer/Basic/Token clauses (attached payload via : = , ; | or brackets incl empty; whitespace payload at end of text or before another sensitive token; bare scheme at end of text or before another scheme; all-caps scheme forms included); sk- with maximal ASCII suffix incl zero; JWT three base64url segments; UUIDs; 16-hex and 32-hex runs; opaque 24+ single tokens except in op context where a valid lower-kebab op is not opaque by length alone; sensitive key/value clauses for password passwd pwd secret token api_key api-key apikey access_key access-key accesskey auth authorization credential uuid sni host key psk code signature sig op cookie cookies header headers private_key private-key privatekey session csrf endpoint url with : or = and any payload incl empty, whitespace payload containing a non-lowercase char at end of text or before another sensitive token, and bare key at end of text; redaction placeholders redacted masked removed incl brackets; query strings; generic key=value clauses.
Residue: the canonical text must contain at least one Unicode letter-or-number token outside the vocabulary bearer basic token authorization api key sk uuid http https url redacted masked removed secret credential; empty or vocabulary-only residue rejects.
Safe controls survive byte-identically: Updated node; Updated token refresh; Basic plan enabled; Bearer service updated; Version 1:2 unchanged; Node renamed successfully; 规则已更新; 订阅源已刷新; Proxy group reordered; 设置已保存; Filter updated for HK; 香港 01 已重命名; Deleted obsolete rule; 缓存已清理; Profile switched to default.
MCP: accept only the exact byte string JSON.stringify({status:'success',action,summary}) where action is the registered originating action and the summary is already canonical (NFKC identity, no controls, no spans, no whitespace collapse, meaningful residue, canonical bound); reject every other byte form and every hostile record with the fixed unknown outcome.
`;

/** Raw input bounds (UTF-16 code units) — checked before any normalization. */
export const RECEIPT_OP_RAW_MAX = 256;
export const RECEIPT_SUMMARY_RAW_MAX = 2048;
/** Canonical bounds — EXCEEDING rejects, never truncates. */
export const RECEIPT_OP_MAX = 64;
export const RECEIPT_SUMMARY_MAX = 512;

/** Meaningful-residue vocabulary (case-folded). */
export const RESIDUE_VOCABULARY = [
  'bearer',
  'basic',
  'token',
  'authorization',
  'api',
  'key',
  'sk',
  'uuid',
  'http',
  'https',
  'url',
  'redacted',
  'masked',
  'removed',
  'secret',
  'credential',
];

/** Sensitive keys + variants (case-insensitive matching). */
export const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'api_key',
  'api-key',
  'apikey',
  'access_key',
  'access-key',
  'accesskey',
  'auth',
  'authorization',
  'credential',
  'uuid',
  'sni',
  'host',
  'key',
  'psk',
  'code',
  'signature',
  'sig',
  'op',
  'cookie',
  'cookies',
  'header',
  'headers',
  'private_key',
  'private-key',
  'privatekey',
  'session',
  'csrf',
  'endpoint',
  'url',
];

/** Bounded CJK IDN TLDs for hostname/endpoint spans (explicit allowlist so
 * ordinary dotted Chinese text stays intact). */
export const CJK_IDN_TLDS =
  '中国|香港|台湾|台灣|公司|网络|網絡|在线|在線|商城|网址|網址|商店|政务|政務|公益|集团|集團|游戏|遊戲|商标|商標|移动|移動|联通|聯通|中信|みんな|コム|世界|企业|企業|娱乐|娛樂|新闻|新聞|购物|購物';

/**
 * ORDERED semantic span regex sources. Every entry is a { name, re, flags }
 * triple; the generator compiles them in order and runs them sequentially
 * (each global match replaced with ONE space). The `opaque24` entry carries
 * `opContext: false` — it is skipped when canonicalizing an op so a valid
 * long lower-kebab op is never classified opaque merely by length.
 *
 * The sensitive-next lookahead used by the scheme/key whitespace-payload
 * forms is assembled by the generator from SENSITIVE_KEYS plus the scheme
 * words (case-folded alternation via character classes).
 */
export const RECEIPT_PATTERNS = [
  { name: 'url', flags: 'giu', re: '\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s"\'<>]+' },
  // bracketed IPv6/zone: [IPv6|zone] with OPTIONAL port — the content must
  // contain at least one colon (hex/colon/dot chars, optional %zone), so
  // ordinary bracketed hex words ("[face]", "[dead]", "[1]", "[updated]")
  // never match
  {
    name: 'endpoint-bracketed-ipv6',
    flags: 'giu',
    re: '\\[(?=[0-9a-f:.]*:)[0-9a-f:.]{1,64}(?:%[A-Za-z0-9._-]{1,32})?\\](?::\\d{1,5})?',
  },
  // bracketed hostname: REQUIRES the port — "[example.com]:8443" is an
  // endpoint, "[updated]" is ordinary text
  {
    name: 'endpoint-bracketed-host-port',
    flags: 'giu',
    re: '\\[[a-z0-9_-]{1,63}(?:\\.[a-z0-9_-]{1,63})*\\]:\\d{1,5}',
  },
  {
    name: 'endpoint-ipv6-compressed-port',
    flags: 'giu',
    re: '\\b(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?:%[A-Za-z0-9._-]{1,32})?:\\d{1,5}(?!\\.\\d)\\b',
  },
  {
    name: 'endpoint-ipv6-full-port',
    flags: 'giu',
    re: '\\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){1,7}:\\d{1,5}(?!\\.\\d)\\b',
  },
  {
    name: 'endpoint-ipv6-mapped',
    flags: 'giu',
    re: '\\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}::(?:\\d{1,3}(?:\\.\\d{1,3}){3}|[0-9a-f]{1,4}:\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d{1,5}(?!\\.\\d))?\\b',
  },
  {
    name: 'endpoint-ipv6-mapped-leading',
    flags: 'giu',
    re: '(?<=^|[^0-9A-Za-z:])::(?:\\d{1,3}(?:\\.\\d{1,3}){3}|[0-9a-f]{1,4}:\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d{1,5}(?!\\.\\d))?(?![0-9A-Za-z])',
  },
  {
    name: 'endpoint-ipv6-trailing-cc',
    flags: 'giu',
    re: '\\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}::(?![0-9A-Za-z])',
  },
  {
    name: 'endpoint-ipv6-compressed-tail',
    flags: 'giu',
    re: '\\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\\.\\d)){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\\.\\d)){0,6})\\b',
  },
  {
    name: 'endpoint-ipv6-omitted',
    flags: 'giu',
    re: '(?<=^|[^0-9A-Za-z:])(?:::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\\.\\d)){0,6})(?::\\d{1,3}(?:\\.\\d{1,3}){3})?(?![0-9A-Za-z])',
  },
  {
    name: 'endpoint-ipv4-port',
    flags: 'giu',
    re: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}:\\d{1,5}(?!\\.\\d)\\b',
  },
  {
    name: 'endpoint-ipv6-full-hextet',
    flags: 'giu',
    re: '\\b(?=[0-9a-f:]*[a-f])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}(?!\\.\\d)){1,7})\\b',
  },
  {
    name: 'endpoint-hostname-port',
    flags: 'giu',
    re: '\\b(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\\.)+(?:xn--[a-z0-9-]{2,20}|[a-z]{2,}):\\d{1,5}(?!\\.\\d)\\b',
  },
  {
    name: 'endpoint-hostname-port-cjk',
    flags: 'giu',
    re: '(?<![\\p{L}\\p{N}_])(?:[\\p{L}\\p{N}_]{1,63}\\.)+(?:{CJK_IDN_TLDS}):\\d{1,5}(?!\\.\\d)(?![\\p{L}\\p{N}_])',
  },
  {
    name: 'endpoint-single-label-port',
    flags: 'giu',
    re: '\\b[a-z][a-z0-9-]{0,31}:\\d{1,5}(?!\\.\\d)\\b',
  },
  { name: 'endpoint-ipv4', flags: 'giu', re: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b' },
  { name: 'endpoint-zone', flags: 'giu', re: '%[A-Za-z][A-Za-z0-9._-]{0,31}' },
  {
    name: 'email',
    flags: 'giu',
    re: '\\b[A-Za-z0-9._%+-]{1,64}@(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\\.)+(?:xn--[a-z0-9-]{2,20}|[a-z]{2,})\\b',
  },
  {
    name: 'email-cjk',
    flags: 'giu',
    re: '(?<![\\p{L}\\p{N}_])[\\p{L}\\p{N}._%+-]{1,64}@(?:[\\p{L}\\p{N}_]{1,63}\\.)+(?:{CJK_IDN_TLDS})(?![\\p{L}\\p{N}_])',
  },
  {
    name: 'hostname',
    flags: 'giu',
    re: '\\b(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\\.)+(?:xn--[a-z0-9-]{2,20}|[a-z]{2,})\\b',
  },
  {
    name: 'hostname-cjk',
    flags: 'giu',
    re: '(?<![\\p{L}\\p{N}_])(?:[\\p{L}\\p{N}_]{1,63}\\.)+(?:{CJK_IDN_TLDS})(?![\\p{L}\\p{N}_])',
  },
  {
    name: 'scheme-attached',
    flags: 'gu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:authorization\\s*[:=]\\s*)?(?:Bearer|Basic|Token)\\s*[:=,;|(){}<>\\[\\]]\\s*[^\\s"\'<>]*',
  },
  {
    name: 'scheme-payload',
    flags: 'gu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:authorization\\s*[:=]\\s*)?(?:Bearer|Basic|Token)\\s+[^\\s"\'<>]+(?=[\\s,;(){}[\\]]*(?:{SENSITIVE_NEXT})|[\\s,;(){}[\\]]*$)',
  },
  {
    name: 'scheme-bare',
    flags: 'gu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:authorization\\s*[:=]\\s*)?(?:Bearer|Basic|Token)(?=\\s+(?:{SCHEME_NEXT})\\b|\\s*$)',
  },
  {
    name: 'scheme-attached-caps',
    flags: 'gu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:authorization\\s*[:=]\\s*)?(?:BEARER|BASIC|TOKEN)\\s*[:=,;|(){}<>\\[\\]]\\s*[^\\s"\'<>]*',
  },
  {
    name: 'scheme-payload-caps',
    flags: 'gu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:authorization\\s*[:=]\\s*)?(?:BEARER|BASIC|TOKEN)\\s+[^\\s"\'<>]+(?=[\\s,;(){}[\\]]*(?:{SENSITIVE_NEXT})|[\\s,;(){}[\\]]*$)',
  },
  {
    name: 'scheme-bare-caps',
    flags: 'gu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:BEARER|BASIC|TOKEN)(?=\\s+(?:{SCHEME_NEXT})\\b|\\s*$)',
  },
  { name: 'sk-prefix', flags: 'giu', re: '(?:^|[^\\p{L}\\p{N}_-])sk-[A-Za-z0-9_-]*' },
  {
    name: 'jwt',
    flags: 'giu',
    re: '\\b[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}',
  },
  {
    name: 'uuid',
    flags: 'giu',
    re: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
  },
  { name: 'hex16', flags: 'giu', re: '\\b[0-9a-f]{16}\\b' },
  { name: 'hex32', flags: 'giu', re: '\\b[0-9a-f]{32}\\b' },
  {
    name: 'opaque24',
    flags: 'giu',
    opContext: false,
    re: '\\b[A-Za-z0-9+/_-]{24,}\\b',
  },
  {
    name: 'key-delim',
    flags: 'giu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:{KEYS})\\s*[:=]\\s*[^\\s"\'<>]*',
  },
  {
    name: 'key-payload',
    flags: 'gu',
    re: '(?:^|[^\\p{L}\\p{N}_-])(?:{KEYS_FOLDED})\\s+(?=[^\\s"\'<>]*[^a-z\\s])[^\\s"\'<>]+(?=[\\s,;(){}[\\]]*(?:{SENSITIVE_NEXT})|[\\s,;(){}[\\]]*$)',
  },
  { name: 'key-bare', flags: 'giu', re: '(?:^|[^\\p{L}\\p{N}_-])(?:{KEYS})(?=\\s*$)' },
  {
    name: 'placeholder',
    flags: 'giu',
    re: '\\b(?:redacted|masked|removed)\\b|\\[(?:redacted|masked|removed)\\]',
  },
  {
    name: 'query',
    flags: 'giu',
    re: '[?&][A-Za-z0-9._-]{1,64}=[^&\\s"\'<>]{0,128}',
  },
  {
    name: 'query-generic',
    flags: 'giu',
    re: '(?:^|\\s)[A-Za-z0-9._-]{1,64}=[^&\\s"\'<>]{0,128}',
  },
];
