# Findings

Severity levels: P0 security or complete-load boundary; P1 connection-critical
semantic loss; P2 narrower compatibility or diagnostics; P3 documentation and
maintainability.

Final inventory: 33 confirmed findings — 6 P0, 25 P1, 2 P2, and 0 P3.

Only findings that pass the evidence gate are listed here. Investigation leads
remain in `workstreams/` until they have a trigger, execution path, evidence,
and a reproducible check.

| ID     | Severity | Protocol/format                                         | Parameter                                           | Current behaviour                                                                                                                                                                                                                                                 | Correct behaviour                                                                                                                                                                                        | Evidence                                                                                                                                                                                        | Fix                                                                                                                                                                                                              | Test                                                                                                                                                                                                             |
| ------ | -------- | ------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PC-001 | P0       | All failed proxy URIs                                   | Userinfo and full URI                               | `errors[].line` contained up to 80 characters from the original URI, including fake credentials in the deterministic reproduction                                                                                                                                 | Diagnostics identify line/scheme without retaining credentials, UUIDs, tokens, keys, or subscription URLs                                                                                                | Initial `uriToClash.ts:90-117,1156-1158`; 2026-07-15 fake-credential `tsx` probe returned `errorLineContainsFakeSecret: true`                                                                   | Replaced raw snippets with `line N (scheme://)` and made URL-constructor failure text generic                                                                                                                    | `proxyUri.test.ts`: `does not retain credentials from a failed URI in diagnostics`; subscription blast set 97/97 passed                                                                                          |
| PC-002 | P1       | Mixed URI lists                                         | Per-line parse failure                              | When at least one URI succeeded, every sibling parse error was discarded and a shorter provider was returned without warning                                                                                                                                      | Reject the subscription or expose a non-silent, contractually handled partial-result state; the public fetch/render path must not silently publish a truncated list                                      | Initial `subscriptionFetcher.ts:480-493`; 2026-07-15 mixed-list probe returned `threw: false, proxyCount: 1` for one valid plus one invalid URI                                                 | Fail closed before returning proxies and report that no partial provider was produced                                                                                                                            | `proxyUri.test.ts`: `rejects a mixed URI list instead of silently dropping failed nodes`; subscription blast set 97/97 passed                                                                                    |
| PC-003 | P1       | SS, SSR, VMess, Hysteria2 and default-port URI families | `port` and port ranges                              | `parseInt` accepted `443junk` as 443 and accepted 70000; the logical-OR default expression converted explicit port 0 to a valid-looking default                                                                                                                   | Accept only a complete decimal integer in 1–65535; apply defaults only when the port is absent; validate every port-hopping range endpoint                                                               | 2026-07-15 fake-link probe accepted all five invalid cases; initial per-parser `parseInt` and logical-OR default branches in `uriToClash.ts`                                                    | Added shared strict `parsePort`; applied it across parser families and Hysteria2 ranges                                                                                                                          | `proxyUri.test.ts`: `proxy URI port validation`; 79/79 passed                                                                                                                                                    |
| PC-004 | P1       | Remote subscriptions and rendered full configs          | Parser/cache schema                                 | Already-normalised provider YAML and full configs had no parser-version invalidation, so pre-fix truncated output could bypass new parsing for up to the stale-cache window                                                                                       | Parser-semantic changes must invalidate both fetch and full-render cache identities on deployment                                                                                                        | `fetchCacheRepo.ts` key previously hashed only URL/UA/headers; `renderCache.ts` epoch remained 9; both pre-fix tests failed                                                                     | Added `FETCH_CACHE_EPOCH = 2`, bumped `RENDER_CACHE_EPOCH` to 10, and documented the cross-file invariant in `web/AGENTS.md`                                                                                     | `fetchCacheRepo.test.ts` plus render epoch-9 miss test; 16/16 passed                                                                                                                                             |
| PC-005 | P0       | Base YAML save and legacy render                        | YAML syntax diagnostics                             | YAML parser exceptions could retain a complete source line containing a node password and propagate it through a 422/error path                                                                                                                                   | Syntax errors must use a fixed credential-free message and carry no parser cause/source excerpt                                                                                                          | Deterministic fake-password probe and [input-security workstream](workstreams/input-security.md#is-008--base-yaml-diagnostics-can-echo-credentials)                                             | `parseBaseDocument` catches every YAML diagnostic and emits only `Invalid base YAML`; save and render share it                                                                                                   | `baseInputSafety.test.ts`: syntax error, save boundary and legacy render assertions                                                                                                                              |
| PC-006 | P0       | Remote subscription URL/fetch                           | userinfo, path, query, custom headers               | The raw fetch `err.message` was copied into Problem Details, `staleReason`, and refresh `last_error`; undici can include the complete credential-bearing URL                                                                                                      | Reject URL userinfo and map all non-timeout network diagnostics to one fixed message before stale/cache/persistence paths                                                                                | Synthetic URL/header sentinels reproduced the leak; [independent review](workstreams/input-security.md) traced the persistence chain                                                            | Schema and fetch boundary reject userinfo; underlying network text is replaced with `Upstream fetch failed`                                                                                                      | `inputSafety.test.ts`, `subscriptionSchema.test.ts`, `staleFallback.test.ts`, object-pipeline stale tests                                                                                                        |
| PC-007 | P1       | Remote subscription body                                | 10 MiB completeness                                 | A cap-sized reader flagged exact-cap as truncated, while the caller ignored `truncated`; a valid YAML prefix plus extra bytes could be normalized and cached as a complete source                                                                                 | Exact-cap EOF must pass; cap-plus-one must reject before decode, parse, or cache                                                                                                                         | Pre-fix exact/cap-plus-one streaming probes in [IS-001](workstreams/input-security.md#is-001--the-10-mib-cap-silently-truncates-and-accepts)                                                    | Reader probes one further chunk; declared and streamed overflow both return a fixed 400                                                                                                                          | `inputSafety.test.ts`: exact cap, cap+1 and valid-prefix chunked overflow                                                                                                                                        |
| PC-008 | P1       | Remote subscription/body and Base64 wrappers            | UTF-8                                               | Non-fatal decoding replaced malformed credential bytes with U+FFFD; the Base64 helper also accepted Node's permissive prefix decode                                                                                                                               | Both byte boundaries require strict canonical Base64 and fatal UTF-8; malformed input must never become a different credential                                                                           | Fake invalid byte and `padding + suffix` probes; fixed parser workstream record                                                                                                                 | Remote body uses fatal `TextDecoder`; Base64 validates alphabet/padding/canonical round-trip and uses fatal UTF-8                                                                                                | `inputSafety.test.ts` plus strict Base64 table in `proxyUri.test.ts`; old helper exposed eight failures                                                                                                          |
| PC-009 | P1       | `Subscription-Userinfo` metadata                        | counters and expiry                                 | Negative/fractional values could be persisted even though `SubscriptionSchema` rejects them later, poisoning the whole row                                                                                                                                        | Untrusted header data must satisfy the persisted runtime schema before use                                                                                                                               | [IS-005](workstreams/input-security.md#is-005--untrusted-traffic-metadata-can-poison-the-stored-subscription-row) schema differential                                                           | `parseTrafficHeader` returns data only after `SubscriptionTrafficSchema.safeParse`                                                                                                                               | `inputSafety.test.ts`: negative, fractional, unknown, infinity and valid controls                                                                                                                                |
| PC-010 | P1       | Base skeleton                                           | root and section types                              | Scalar/sequence roots and wrong-typed `proxies`, groups, providers, or rules could be saved/served, eventually yielding an unloadable Mihomo document                                                                                                             | Require a mapping root and the fixed sequence/map shape for every managed top-level section on save and render                                                                                           | [IS-004](workstreams/input-security.md#is-004--base-parservalidator-accepts-a-non-mapping-document); parser/render path trace                                                                   | Shared `parseBaseDocument` validates root and known sections; literal proxies use the same node validator                                                                                                        | `baseInputSafety.test.ts`: 12 root/save/render checks plus section/node cases; parser/integration suite                                                                                                          |
| PC-011 | P1       | Structured provider YAML, cache and operators           | node type/required fields                           | Array membership plus a loose endpoint heuristic accepted unknown/policy types, missing SS credentials and invalid operator output; such a source still counted as fulfilled                                                                                      | Validate fixed Mihomo dispatch types, closed field schemas, exact scalar types, nested objects, and constructor invariants before cache/export/injection and after every operator pipeline               | Fixed Mihomo rejected unknown, policy-as-proxy and SS-without-credentials fixtures; [IS-003](workstreams/input-security.md#is-003--provider-nodes-have-no-structural-or-protocol-validation)    | Added a closed fixed-v1.19.28 registry validator for 24 portable types; reused for direct/cache/stale/base/export/sub-operator/collection-operator/final render                                                  | `mihomoProxyValidator.test.ts` portable-type, field-schema, nested-object, enum/dependency, resource and graph matrices; provider/object/node-export/resolve/base regressions; fixed binary probes               |
| PC-012 | P1       | Public/cached full config                               | failed subscription                                 | `resolveConfig`'s permissive default allowed a missing source to become a successful partial full config and render-cache entry                                                                                                                                   | Downloadable/cached full configs must fail closed; stale last-known-good is the only tolerated source fallback                                                                                           | [IS-007](workstreams/input-security.md#is-007--partial-full-configs-are-hidden-and-cached) and pre-fix option-spy test                                                                          | `renderProfileConfig` passes `ignoreFailedSubs: false` and writes only after resolution succeeds                                                                                                                 | `renderCache.test.ts`: fail-closed option, epoch miss, corrupt-envelope miss; resolve failure order tests                                                                                                        |
| PC-013 | P1       | VLESS                                                   | `security`, Reality key/fingerprint/short ID        | Empty/unknown/wrong-case security could turn an intended secure node into non-TLS output; incomplete Reality produced an invalid target node                                                                                                                      | Accept only exact `none`, `tls`, `reality`; Reality requires canonical 32-byte Base64URL public key and client fingerprint, with bounded even-hex short ID                                               | Xray proposal, fixed Mihomo/Xray sources, and fixed Mihomo rejection of unset Reality public key                                                                                                | Strict security enum and fail-closed Reality validation; canonical Mihomo fields only                                                                                                                            | VLESS security table in `proxyUri.test.ts`; fixed `vless-security-transport.yaml` passes Mihomo                                                                                                                  |
| PC-014 | P1       | VLESS                                                   | `encryption`                                        | Explicit empty/malformed long strings were accepted or changed; the same raw field has incompatible target semantics across cores                                                                                                                                 | Preserve valid encrypted strings byte-for-byte, map URI `none` only for Mihomo output, and reject empty/invalid length/mode/rtt/key                                                                      | Fixed Mihomo encryption factory plus Xray `vlessenc`; Xray accepts its generated forms while v2ray-core rejects them                                                                            | Target-aware strict grammar for 32-byte X25519 and 1184-byte ML-KEM material; no secondary decode                                                                                                                | Parser boundary table and fixed core comparison in [validation.md](validation.md#cross-core-vless-configuration-probes)                                                                                          |
| PC-015 | P1       | VLESS                                                   | packet encoding                                     | Explicit URI `none` was omitted, but fixed Mihomo treats omission as XUDP, silently converting raw/none into XUDP                                                                                                                                                 | Omission deliberately selects the Mihomo default; explicit XUDP/packetaddr map canonically; unrepresentable explicit raw/none rejects                                                                    | Fixed Mihomo source/docs conflict and independent review reproduction                                                                                                                           | Emit `packet-encoding: xudp` or `packet-encoding: packetaddr`; reject explicit `none` until a neutral model can represent it                                                                                     | Parser tests for omitted/xudp/packet/packetaddr/none/unknown; fixed fixture exposes both accepted values                                                                                                         |
| PC-016 | P1       | VLESS transport/XHTTP                                   | `type`, duplicate query, `extra`, download security | Unknown transports could reach a target fallback; duplicate singleton parameters collapsed; malformed/nested XHTTP values and invalid `stream-one + downloadSettings` combinations passed or were misread                                                         | Closed transport and query tables, exact scalar types, canonical nested Reality aliases, and Xray mode invariants                                                                                        | Fixed Mihomo converter and Xray XHTTP source; independent canonical-nested reproduction                                                                                                         | Strict transport mapper, duplicate/casing guards and typed XHTTP/downloader conversion                                                                                                                           | VLESS transport/XHTTP tables in `proxyUri.test.ts`; fixed VLESS full config passes Mihomo                                                                                                                        |
| PC-017 | P1       | Shadowsocks/SIP002/SIP003                               | wrapper/plugin/options                              | SS TLS/Reality/transport wrapper keys and unsupported plugins were silently removed by Mihomo, turning the request into direct SS; escaped plugin delimiters and `mux=0` changed meaning                                                                          | Only target-representable plugins may succeed; a present wrapper/plugin must map exactly or reject                                                                                                       | SIP002/SIP003, fixed Mihomo `ShadowSocksOption`, and a fixed binary config that accepted-but-ignored wrapper keys                                                                               | Reject unsupported wrappers/plugins/modes; escape-aware tokenizer; explicit mux false; strict ShadowTLS payload                                                                                                  | SS table in `proxyUri.test.ts`; old strict suite contributed to `45 failed`, final parser batch passed                                                                                                           |
| PC-018 | P1       | Legacy VMess JSON                                       | scalar types, transport, pins                       | Blanket `String()` coercion could turn bad `aid` into zero and object TLS into disabled TLS; QUIC/unknown network fell back to TCP; pins/verification names disappeared                                                                                           | Validate types before coercion, use a closed target transport map, and reject target-unrepresentable certificate constraints                                                                             | v2rayN format, Xray/v2ray-core/Mihomo fixed sources and Mihomo accepted-but-fell-back QUIC probe                                                                                                | Strict scalar grammar; map TCP HTTP/H2/mKCP; reject QUIC/unknown, `pcs` and `vcn`; map proven fingerprint/insecure fields                                                                                        | VMess tables in `proxyUri.test.ts`; fixed parser workstream records pre-fix and final counts                                                                                                                     |
| PC-019 | P2       | SSR                                                     | Base64 and target-gap fields                        | Malformed encoded password/parameters could survive as changed text; non-empty `udpport`/`uot` disappeared                                                                                                                                                        | Invalid encoding and target-unrepresentable active fields must reject; grouping metadata may be deliberately ignored                                                                                     | Archived SSR grammar plus fixed Mihomo SSR option structure                                                                                                                                     | Strict required/optional Base64; reject active `udpport`/`uot`; validate then intentionally ignore group metadata                                                                                                | SSR negative/alias tests in `proxyUri.test.ts`                                                                                                                                                                   |
| PC-020 | P2       | Fetch/render cache envelopes                            | metadata/runtime type                               | Typed Redis reads performed no runtime validation and trusted cached proxy counts even when YAML disagreed                                                                                                                                                        | Corrupt envelopes are cache misses; validated payload determines node count                                                                                                                              | Independent cache audit and mismatch probes                                                                                                                                                     | Added envelope guards for fetch/render caches; cache-hit count comes from validated YAML                                                                                                                         | `fetchCacheRepo.test.ts`, corrupt render-envelope test, object-pipeline count mismatch test                                                                                                                      |
| PC-021 | P1       | VMess/VLESS HTTPUpgrade                                 | `net/type=httpupgrade`                              | Fixed Mihomo's share converter preserved `network: httpupgrade`, but its VMess/VLESS outbound switch has no matching case and silently constructed raw TCP                                                                                                        | Emit the target's implemented WebSocket carrier plus the explicit HTTPUpgrade flag and its fast-open flag                                                                                                | Fixed Mihomo v1.19.28 converter and outbound source at `cbd11db`; generated `http-upgrade.yaml`                                                                                                 | Both parsers canonicalize to `network: ws` plus `ws-opts.v2ray-http-upgrade`; early data enables `v2ray-http-upgrade-fast-open`                                                                                  | Parser/full-delivery assertions and fixed Mihomo fixture set 6/6                                                                                                                                                 |
| PC-022 | P1       | All URI families and VLESS XHTTP                        | unknown/duplicate/orphan parameters                 | Several parsers accepted unknown query keys, alias collisions, paths, or known fields that were then omitted; nested XHTTP coerced or skipped mistyped values                                                                                                     | Closed per-family grammars, duplicate/alias rejection, strict nested JSON, and cross-field invariants; only explicitly documented metadata omission may succeed                                          | Fixed target structs/converters plus protocol/client grammars; independent silent-drop and gap reviews                                                                                          | Closed allowlists for all 13 families; deep XHTTP object/enum/range/placement validation; SOCKS path/query and H2 `keepalive` explicitly reject                                                                  | Closed-grammar and XHTTP advanced/negative tables in `proxyUri.test.ts`; final matrix has zero `silent_drop`/`unknown` statuses                                                                                  |
| PC-023 | P1       | URI and structured provider identities/endpoints        | VMess/VLESS user ID; H1/H2 `ports`                  | Unbounded user strings reached target construction; structured Hysteria nodes required scalar `port`; large port ranges could expand without an aggregate budget                                                                                                  | Lowercase canonical UUIDs, deterministically map bounded 1..30-byte custom IDs to UUIDv5, and enforce H1/H2 `port`-or-`ports`, 28 segments, and a 65,536-candidate list budget                           | Fixed Mihomo custom-ID/constructors and fixed-binary ports-only probes                                                                                                                          | Shared user-ID helper handles canonical UUIDs before the custom-length branch; URI and structured lists share normalization and bounded port expansion                                                           | Custom-ID order/length tests, Hysteria validator/resource tests, fixed Mihomo provider boundary set 15/15                                                                                                        |
| PC-024 | P0       | Final renderer                                          | markers, cross-section references, chain clones     | Missing markers, unknown rule sets/policies, dangling group/provider/dialer references, removed `relay` groups, or invalid chain wraps could produce a successful-looking but unloadable full config                                                              | Every managed section/reference must resolve, only fixed-target group types may survive, and the complete post-clone proxy graph must pass the same final validator                                      | Renderer/resolve execution trace plus fixed Mihomo load boundary                                                                                                                                | Missing markers/references and relay throw; multi-member wraps and collisions throw; final base+subscription+clone document revalidates resources, names, group DAG, providers, dialer graph, and policies       | `resolve.test.ts` marker/rule-set/operator/chain/final-reference cases and final validator regressions                                                                                                           |
| PC-025 | P1       | Render/fetch cache generation                           | corrupt time/version/build identity                 | Future timestamps, oversized freshness, mismatched build IDs, and a present-invalid `config:version` could preserve or revive stale generation-zero data                                                                                                          | Validate the entire envelope; invalid versions neither hit nor write and repair with compare-and-set without overwriting concurrent increments                                                           | Independent cache review and concurrency reproduction                                                                                                                                           | Content-derived SHA-256 build ID, 24-hour/clock-skew bounds, invalid-generation eviction and nonzero CAS repair                                                                                                  | `renderCache.test.ts` corruption, cross-profile legacy-v0, future-time, max-freshness, and delayed-repair races; fetch-cache future-time probe                                                                   |
| PC-026 | P0       | AnyTLS, WireGuard, Hysteria2, and XHTTP                 | duration/count resource scalars                     | Safe-JavaScript integers could still overflow fixed Mihomo's signed Go duration conversion, retain unbounded AnyTLS idle sessions, or request three WireGuard goroutines per unbounded worker                                                                     | Cap seconds at 9,223,372,036 and bound URI-controlled retained sessions/workers to 256 before output or structured-provider delivery                                                                     | Fixed Mihomo duration conversions and WireGuard device worker construction                                                                                                                      | Shared bounded integer/range validation; the same limits apply to URI and structured nodes                                                                                                                       | Overflow and 257-count parser/validator regressions                                                                                                                                                              |
| PC-027 | P1       | Dynamic proxy groups and chain wraps                    | `empty-fallback`, include-all clone exclusion       | The create/update/template path discarded an explicit fallback; a zero-match group therefore used fixed Mihomo's implicit `COMPATIBLE`, while an include-all pool could pull a generated chain clone back into its own dialer path                                | Preserve a concrete user fallback, default otherwise-empty dynamic groups to explicit `REJECT`, and exclude every generated clone without replacing the user's filter program                            | Fixed Mihomo `ProxyGroupBaseOption`/group-base source and a checksum-pinned zero-match/chain-clone reproduction                                                                                 | Added the field across schema/editor/template merge and final validation; include-all-proxies/include-all appends an anchored clone pattern with Mihomo's backtick separator                                     | Proxy-group schema round trips plus `resolve.test.ts` empty-dynamic-group, invalid fallback, preserved filter, and smart-front-pool cases                                                                        |
| PC-028 | P1       | Structured OpenVPN, WireGuard, and MASQUE               | `remote-dns-resolve`, `dns`, OpenVPN `udp`          | The validator did not enforce the fixed constructor's paired DNS fields or nameserver grammar; OpenVPN `udp` decoded successfully but the constructor never consumed it                                                                                           | Remote resolution is enabled iff a non-empty, safely parsed DNS list is present; every nameserver is validated; a fixed-target no-op field rejects                                                       | Fixed Mihomo `dns.ParseNameServer` call sites and OpenVPN option/constructor source; independent source/binary review                                                                           | Shared conservative nameserver validator and pair dependency for all three types; removed OpenVPN `udp` from its admitted structured schema; flat WireGuard URI remote DNS explicitly rejects                    | `mihomoProxyValidator.test.ts` 384-case suite, including three-type pair/grammar tables and OpenVPN no-op rejection; provider/full-chain delivery cases                                                          |
| PC-029 | P0       | Final Mihomo rule grammar and runtime regexes           | IP prefixes; Unicode IgnoreCase; comma payloads     | A dotted IPv4 literal in the left half of compressed IPv6 could pass; regex safety missed forced IgnoreCase and Unicode folds hidden in literals, fixed/braced escapes, class ranges, or property classes; fixed comma trimming could rewrite nested payloads     | Reject every prefix that Go `netip` rejects; guard unsupported `i`+`u` fold surfaces and reject `i`+`v` wholesale; reject every comma-bearing payload changed by fixed trimming                          | Fixed rule constructors/Go `netip`, 15 binary fixtures, parser/timing probes, and an independent 9,018-regular plus 8,955-long-braced encoding oracle                                           | Under `i`+`u`, shared safety decodes complete braced escapes, then rejects caseful non-ASCII code points, non-ASCII range endpoints, and properties; `i`+`v` rejects wholesale; trim comparison is recursive     | `operators.test.ts`, `proxyUri.test.ts`, `rule.test.ts`, `resolve.test.ts`, and `ipLiteral.test.ts` cover literals, long leading-zero escapes, ranges/properties, uncased controls, comma loss, and IP placement |
| PC-030 | P1       | Base YAML and rule-provider renderer                    | Executable `RULE-SET` reference discovery           | Whole-text matching could activate a dormant provider from `RULE-SET,ads` inside regex text; the contextual extractor also matched `foo-rule-set:ads`, turning ordinary sniffer text into a remote provider URL/fetch                                             | Activate providers only from fixed-Mihomo rule trees and exact index-zero, case-insensitive `rule-set:` contextual prefixes, preserving each context's colon/comma semantics; embedded text stays inert  | Independent reproductions returned `ruleProvidersApplied: ['ads']` and included the fake dormant URL; fixed source/binary and a 20,496-form prefix/colon/comma oracle define the split boundary | YAML parse-tree plus shared fixed-rule-tree collector; context-aware prefix parsing mirrors the distinct nameserver-policy versus sniffer/fake-IP split rules and preserves empty tokens fail-closed             | `ruleProviders.test.ts` and `resolve.test.ts` prove regex/embedded names stay dormant, colon semantics match fixed, and real direct/nested/contextual references still activate or reject                        |
| PC-031 | P1       | Context-gated rule-set consumers                        | fake-IP filter and TUN route address sets           | Provider references were collected while fake-IP or TUN consumers were inactive, emitting dormant remote URLs or false missing-provider errors; TUN also admitted behavior that fixed Mihomo silently does not apply                                              | Collect fake-IP references only in fake-IP mode; collect TUN sets only on active auto-route+auto-redirect paths; require TUN providers to use `ipcidr`; reject active no-op/empty states                 | Fixed `config.go` fake-IP gate and `sing_tun` construction/update strategy; independent dormant-provider and wrong-behavior probes                                                              | Case-insensitive fake-IP mode; root omitted `auto-route` defaults true, listener requires explicit true; exact scalar types and canonical keys; empty, missing, or non-`ipcidr` sets fail closed                 | `ruleProviders.test.ts`/`resolve.test.ts` plus a 13-context oracle cover DNS, fake-IP, four sniffer lists, rules/sub-rules, root/listener defaults, aliases/types, no-ops, names, and behavior mismatch          |
| PC-032 | P1       | Base Mihomo YAML                                        | semantic YAML merge keys                            | Fixed Mihomo expanded inherited sections through `<<`, while the JavaScript AST kept an unexpanded merge pair; inherited rules or contextual provider references could therefore bypass collection and reach an unloadable or semantically different final config | Reject target-semantic merge syntax at the common base parse boundary; preserve quoted `"<<"`, explicit `!!str <<`, and JSON literal keys because fixed does not treat them as merges                    | Fixed v1.19.28 binary probe: a merged DNS nameserver-policy referenced missing `ghost` and failed load, while the pre-fix collector saw only the literal `<<` pair                              | Traverse the YAML AST and mirror go-yaml `isMerge`: reject untagged plain `<<`, local-`!` `<<`, and the explicit merge tag before save/validation/render; leave non-merge aliases/literals intact                | `baseInputSafety.test.ts` plus 7 block/flow/recursive/tag probes cover inherited references, stored render, semantic merge variants, and quoted/`!!str` literal controls                                         |
| PC-033 | P1       | Remote subscription fetch runtime                       | direct `undici` dependency                          | The audit added direct runtime `undici@6.25.0`, which npm's advisory data classifies high severity throughout `<=6.26.0`; a clean install would therefore retain a known-vulnerable HTTP client range                                                             | Use a patched release compatible with the declared Node 22 runtime, pin it exactly, and verify both the installed direct version and lockfile integrity without claiming unrelated audit debt is cleared | Clean-install `npm audit` range; npm registry metadata for 6.27.0 reports Node `>=18.17` and integrity `sha512-YmfV…m+pg==`                                                                     | Exact-pin `undici` 6.27.0 in `package.json` and lock its registry artifact; keep the lockfile change minimal instead of applying unrelated major-version audit rewrites                                          | Clean `npm ci`; direct `npm ls` is 6.27.0 and audit omits Undici; safe-fetch 18/18, runtime HTTP 200/`ok`, full 52/1,360, coverage, typecheck, and build pass                                                    |
| PC-034 | P0       | Persisted subscriptions, collections, groups, templates | strict schema reuse during upgrade                  | New write/runtime restrictions also decoded existing Redis rows, so legacy relay groups, comma `exclude-type`, URL userinfo, and newly unsafe operators could disappear from management lists and leave dangling references                                       | Split tolerant persisted decoding from strict create/update/runtime validation; quarantine relay, park unsafe operators, and normalize only provably equivalent comma lists                              | Deterministic pre-fix schema probe reproduced all five rejection paths; repository call-chain review confirmed `safeParse -> null -> filter` in all four resource repos                         | Stored relay becomes a marked non-renderable placeholder; historical unsafe operators retain their configuration but are forced disabled; stored URL userinfo remains editable but the fetch boundary rejects it | `persistedCompatibility.test.ts` plus the full 52-file/1,360-test suite, typecheck, scoped lint/format, coverage, and production build                                                                           |

## PC-001: proxy URI credentials retained in diagnostics

At baseline, `parseProxyUriList` passed `truncate(line)` into both unsupported
and parser-failure diagnostics, and truncation limited length without redacting
the userinfo or query string. A deterministic probe using only a generated fake
secret confirmed that the secret remained in `errors[].line`.

Observable blast radius under review: direct parser callers, the normalizer's
three-error sample, stale fallback reasons, collection member errors, HTTP
problem responses, and any logs or UI that serialise those values.

## PC-002: successful sibling hides failed URI lines

At baseline, after `parseProxyUriList` returned both `proxies` and `errors`,
`normaliseToClashProxies` returned immediately on `proxies.length > 0` without
examining `errors`. A deterministic one-good/one-bad input therefore produced a
one-node provider and no warning.

The adopted contract is fail-closed because existing result types do not carry
per-node warnings through cache, provider response, collection merge, or final
render.
Adding an opt-in partial mode would require a separately reviewed end-to-end
diagnostic model.

## PC-003: invalid ports accepted or rewritten

Root cause: protocol parsers independently used permissive `parseInt` calls,
and default-port protocols used `parseInt(...) || default`. The former consumed
numeric prefixes and omitted the TCP/UDP upper bound; the latter treated an
explicit zero as if the port were absent. Hysteria2 additionally validated the
shape of a hopping range without validating each endpoint.

The shared parser now rejects non-decimal, zero, negative, and greater-than-65535
ports. Valid boundary ports 1 and 65535 remain covered.

## PC-004: parser fixes did not invalidate cached parsed output

Root cause: the fetch-cache key represented only upstream request identity,
although its value is parsed provider YAML; the independent render cache could
also return a full config before the fetch layer ran. A parser deployment alone
does not bump the data `config:version`.

Both cache layers now have an explicit deployment epoch for this semantic
change. The invariant is recorded in `web/AGENTS.md` so future parser-output
changes cannot safely update only one layer.

## PC-005: YAML syntax errors retained credential-bearing source text

Minimal reproduction: a syntactically broken `proxies` item containing the
literal fake password `FAKE_SECRET_DO_NOT_USE` caused the YAML library's source
excerpt to survive in the thrown error. Root cause: `parseBase` and the legacy
render path exposed parser diagnostics instead of crossing one sanitized
boundary. `parseBaseDocument` now converts syntax failures to the exact message
`Invalid base YAML` and deliberately stores no `cause`. Save, legacy render,
and direct parser tests assert that neither the sentinel nor its source line is
reachable. Residual risk: other YAML entry points must use this helper or an
equivalent fixed diagnostic; a source scan and final red-team pass cover that
boundary.

## PC-006: remote fetch diagnostics could persist subscription credentials

Minimal reproduction: undici rejects a URL containing HTTP userinfo with an
error that includes the complete URL; a second fake error included unique path,
query, and header sentinels. Root cause: `fetchSubscriptionInternal` interpolated
`err.message`, and `resolveSubscriptionRaw` reused the resulting text as
`staleReason`; the refresh route persists that same message as `last_error`.
The schema and fetch boundary now reject URL userinfo, and every non-timeout
network failure becomes `Upstream fetch failed`. Tests cover direct errors and
stale fallback. Residual risk: subscription tokens legitimately remain in the
stored URL/cache-key input; they are hashed for cache identity and must remain
redacted by every administrative/logging view.

## PC-007: capped body prefixes were accepted as complete subscriptions

Minimal reproduction: a valid provider YAML followed by a comment/filler at
exactly 10 MiB and at 10 MiB + 1 byte. Root cause: `readCapped` treated a chunk
that exactly filled the remaining room as truncated, while the subscription
caller ignored the flag entirely. The reader now distinguishes EOF at the cap
from observing an extra byte, and the caller rejects both an oversized declared
length and streamed overflow before UTF-8 decode, normalization, or cache write.
Residual risk: the 10 MiB limit bounds bytes, not YAML parse complexity; the
YAML library's alias limit and final node-count/performance tests remain the
second resource boundary.

## PC-008: permissive byte decoding changed credentials

Minimal reproductions used `0xff` inside a fake password and a legal Base64
payload followed by text after padding. Root cause: the remote body used a
non-fatal decoder and `tryBase64Decode` delegated grammar to Node's permissive
`Buffer.from`, which may stop at padding or replace malformed UTF-8. Both paths
now use fatal UTF-8; Base64 also checks alphabet, padding placement, remainder,
and canonical standard/Base64URL round-trip while retaining legal missing
padding and folded whitespace. Residual risk: no non-UTF-8 subscription charset
is promised; such a source now fails explicitly instead of being guessed.

## PC-009: traffic metadata violated its own persistence schema

Minimal reproduction: `upload=-1; expire=4.5` parsed successfully but made a
subsequent `SubscriptionSchema.safeParse` fail. Root cause: the header parser
used only JavaScript numeric conversion while the stored schema requires
nonnegative counters and integer expiry. The parser now validates the complete
four-field object with `SubscriptionTrafficSchema` and drops invalid metadata
without failing an otherwise valid node source. Residual risk: missing accepted
fields still receive the product's historical zero default; this is documented
and does not poison storage.

## PC-010: base root and managed section shapes were not enforced

Minimal reproductions were `hello`, `[]`, `rules: {}`, and a literal proxy with
an unknown fake type. Root cause: save and render checked YAML syntax but not the
mapping/section contracts later assumed by the renderer. The shared parser now
requires a mapping root, sequences for `proxies`/`proxy-groups`/`rules`, maps
for both provider sections, and validates literal proxy nodes. Errors contain
only section or indexed field names. Residual risk: not every optional Mihomo
top-level section has a local schema; fixed-binary validation remains the oracle
for generated audit fixtures and uncommon handwritten base fields.

## PC-011: structured provider validation was an endpoint heuristic

Minimal reproductions included an unknown type with a plausible endpoint, an
SS node without cipher/password, `type: select` inside `proxies`, and a rename
operator that produced an empty name. Root cause: the old validator required
only name/type and, for most values, server/port; it also ran before rather than
after operators. The replacement registry follows fixed Mihomo v1.19.28's
`ParseProxy` dispatch, rejects policy/group aliases and weak scalar types, and
runs at direct YAML, cache, base, operator, collection, export, and render
boundaries. All 24 portable registry types have a closed top-level field schema
with exact primitive types. Common TLS/smux plus transport-, plugin-,
WireGuard-, Snell-, Realm-, Trojan-, Sudoku-, and TLS-mirror nested objects are
also closed; enum, TLS dependency, resource, and alias-conflict invariants reject
before target delivery. Fixed Mihomo rejected representative negative wrappers
and accepted representative positive ones. Conditional credentials are
validated too: Shadowsocks-2022 requires canonical Base64 PSKs of the selected
method's exact decoded key length, and only its AES methods admit
colon-separated EIH chains.
Residual risk: this structural contract and its selected constructor invariants
are deliberately stricter than Mihomo's weak YAML decoder, but do not
reimplement every constructor's runtime or network behavior. Config-only types
remain classified separately from the 13 promised URI families.

## PC-012: a failed source could become a cached partial full config

Minimal reproduction: one successful and one rejecting subscription resolved
through the public render front door while a spy captured the default
`ignoreFailedSubs` option. Root cause: `resolveConfig` is intentionally tolerant
for interactive callers, but `renderProfileConfig` inherited that default and
then cached the shorter result. The cached/downloadable path now explicitly
uses `ignoreFailedSubs: false`; fetch-layer stale fallback remains valid because
it returns a previously validated complete provider. Cache writes still happen
only after resolution. Residual risk: lower-level callers may opt into tolerant
mode, but their `subscriptions[].error` must be surfaced and they are not the
public cache producer.

## PC-013: VLESS security and Reality could fail open or build invalid output

Minimal cases covered missing, empty, wrong-case and unknown `security`, Reality
without `pbk`/`fp`, malformed public key, and invalid short ID. Root cause:
truthy/string comparisons interpreted unknown values as ordinary no-security
and constructed incomplete target objects. The parser now accepts only exact
constants, requires a canonical 32-byte unpadded Base64URL public key plus a
client fingerprint for Reality, and validates the optional even-length short
ID. Fixed Mihomo rejects a present `reality-opts` mapping with an unset public
key, while omitting `reality-opts` entirely is accepted as ordinary TLS; this is
why ProxyManager rejects incomplete Reality before construction. The generated
valid Reality fixture passes. Residual risk: the share proposal is mutable;
future constants require an evidence/version update rather than permissive
fallback.

## PC-014: VLESS Encryption was treated as a portable loose string

Minimal cases include explicit empty, invalid family/mode/rtt, 31-byte key,
valid 32-byte X25519 material, and a generated 1184-byte ML-KEM form. Root cause:
the importer did not mirror the fixed encryption factory and could normalize a
byte-sensitive value. The validator now mirrors the accepted family and key
sizes and preserves the encoded value exactly; URI `none` is converted only at
the Mihomo adapter boundary. Xray's own `vlessenc` values pass Xray, while fixed
v2ray-core rejects both, proving the target-specific boundary. Residual risk:
configuration validation is not a live encrypted handshake.

## PC-015: explicit VLESS raw packet mode became XUDP

Minimal reproduction: `packetEncoding=none` yielded no output field. Root cause:
the importer treated explicit none like omission, while the pinned Mihomo source
defaults omission to XUDP despite a conflicting documentation description.
The adopted target contract is omission/explicit XUDP -> canonical XUDP,
`packet`/`packetaddr` -> canonical packetaddr, and explicit none -> rejection
because the current Mihomo emitter cannot express the requested raw semantic.
Residual risk: this is pinned-version behavior and must be rechecked on a target
upgrade.

## PC-016: VLESS transport/XHTTP values crossed untyped and last-wins boundaries

Minimal cases covered duplicate query keys, noncanonical casing, unknown
transport, invalid header type, malformed `extra`, bad nested port/security,
canonical nested Reality aliases, and `stream-one` combined with downloads.
Root cause: `URLSearchParams` was collapsed to a record before duplicate checks
and nested JSON was copied/coerced without the target invariants. The parser now
checks query integrity first, maps a closed transport table, validates typed
nested objects/ports/security, and enforces Xray's mutually exclusive mode.
Residual risk: only the documented/pinned subset of evolving XHTTP `extra` is
mapped; unknown or wrong-typed semantics reject rather than disappear.

## PC-017: SS wrappers and plugins silently became direct Shadowsocks

Minimal cases were `security=tls&type=ws`, an unknown plugin, malformed
ShadowTLS payload, an escaped semicolon, non-WebSocket v2ray-plugin mode, and
`mux=0`. Root cause: Sub-Store/client wrapper keys were copied into top-level
SS fields absent from Mihomo's `ShadowSocksOption`, while unhandled plugin paths
returned the base SS node. The parser now rejects unrepresentable wrappers and
plugins, tokenizes SIP003 escapes, validates ShadowTLS payloads, and preserves
explicit mux disable. A fixed Mihomo configuration test demonstrates why mere
`-t` success on ignored wrapper fields was not sufficient. Residual risk:
additional Mihomo plugin families are explicit missing features, not wildcard
compatibility.

## PC-018: legacy VMess coercion and transport fallback changed security

Minimal reproduction used Boolean `aid`, object-valued TLS, QUIC/unknown
network, TCP fake HTTP, mKCP seed/header, and non-empty certificate controls.
Root cause: a universal `String()` helper erased JSON types and an open network
string reached Mihomo's TCP default branch. The parser now validates every
scalar before coercion, preserves safe integer alter ID, maps the target's
representable transport forms, and rejects QUIC/unknown or unrepresentable
`pcs`/`vcn`. Residual risk: modern VMess AEAD URL input is separately classified
as unimplemented; legacy VMess UDP packet-default evidence remains inconclusive.

## PC-019 and PC-020: explicit P2 compatibility/cache hardening

SSR now treats present-but-invalid Base64 as an error and rejects active fields
the pinned target cannot express. Fetch/render cache reads now validate their
runtime envelopes; provider YAML, rather than stored `proxy_count`, determines
the count on a hit. These changes close ambiguity and corruption paths without
claiming a new input or output format.

## PC-021 through PC-034: final fail-closed integration

The final pass closed six cross-cutting paths that a per-parser audit alone
would miss. VMess and VLESS HTTPUpgrade now use Mihomo's implemented WebSocket
carrier rather than an unhandled network string. Every URI family has a bounded
query/JSON grammar, while XHTTP recursively rejects unknown, duplicate,
mistyped, fractional, empty, or semantically orphaned fields. Root and nested
XHTTP headers enforce HTTP-token names, reject `Host`, and reject line breaks;
the official and compatibility uplink-method spellings conflict-reject, values
uppercase, and `GET` requires `packet-up`. Enabled padding materialises pinned
defaults, named session tables expand exactly, session lengths/ranges stop at
256 with a bounded range cardinality and minimum identifier space, and positive
xmux connection/concurrency modes cannot coexist. Chunk/post integers must be
positive JSON safe integers and become exact decimal strings for fixed Mihomo;
zero chunk size rejects before its runtime loop. VMess/VLESS canonical UUIDs
lowercase before the custom-ID branch, while bounded custom IDs map
deterministically to UUIDv5. Hysteria query addons use form decoding,
certificate pins normalize from an
exact 64-hex value, and port sets are bounded both per node and across the
delivered list while preserving fixed-binary-validated ports-only inputs.

At the renderer boundary, markers and live rule-set references are mandatory.
The scan covers ordinary rules and sub-rules, both DNS nameserver-policy maps,
fake-IP filters only in fake-IP enhanced mode, sniffer domain/IP lists, and both
address-set fields only on active root or listener-local TUN
auto-route+auto-redirect paths, using their distinct target defaults. It also
rejects IP-only providers in domain
contexts, domain-only providers in ordinary IP contexts, and every non-`ipcidr`
provider in TUN route contexts. Chain clones are materialised before a final complete-list validation,
so no merge stage can bypass node count, name uniqueness, Hysteria expansion,
or `dialer-proxy` graph checks. Include-all groups append generated chain-clone
exclusions as separate backtick-delimited regexp2 patterns, preserving user
filters without feeding a clone back into its own dialer path. A final-document
pass additionally resolves every group member/provider, concrete dialer target,
and rule policy; enforces a group-membership DAG and non-empty source; defaults
empty dynamic groups to fail-closed `empty-fallback: REJECT` unless another
concrete fallback is explicit; rejects cross-kind/reserved name collisions and
ignored group fields; and excludes the fixed target's removed `relay` type.
Cache entries are accepted only when content, content-derived build ID,
metadata, time bounds, freshness, epoch, provider identity, and global
generation agree. Invalid global generations cannot hit or write a legacy
entry; their compare-and-set repair is race-safe.

Resource-bearing scalars also stop at the target boundary: duration values are
capped at 9,223,372,036 seconds before conversion to signed Go nanoseconds, and
AnyTLS retained sessions plus WireGuard workers are capped at 256. This closes
both integer wraparound and URI/provider-controlled allocation fanout.

The red-team pass then closed two target-specific integration gaps. Fixed
Mihomo defaults an empty dynamic group to `COMPATIBLE`; ProxyManager now carries
`empty-fallback` through create, update, template, UI, and final-render paths,
defaults an otherwise-empty dynamic source to `REJECT`, and accepts only a
concrete proxy or fixed builtin as an explicit fallback. Generated chain clones
are excluded from `include-all-proxies`/`include-all` pools with a separately
backtick-delimited anchored regexp2 pattern, so an existing user expression is
preserved and the clone cannot re-enter its own dialer path.

OpenVPN, WireGuard, and MASQUE all pass their structured `dns` entries through
fixed Mihomo's nameserver parser when `remote-dns-resolve` is enabled. The
shared validator therefore requires `true` and a non-empty list together and
admits only a conservative, fully consumed subset: plain IP or valid ASCII
host with an optional port; `udp`, `tcp`, `tls`, `http`, `https`, or `quic`
network forms; and bounded `system`, `ts`/`tailscale`, `dhcp`, or `rcode`
forms. Whitespace, malformed hosts or ports, credentials, query/fragment
suffixes, and ignored paths reject. OpenVPN `udp` also rejects because the
fixed constructor does not consume that decoded option. The flat WireGuard URI
dialect cannot carry the paired `dns[]`, so its `remote-dns-resolve` query is an
explicitly unsupported parameter rather than a link that parses but fails at
delivery.

The final fixed-rule differential closed three more decoder/runtime gaps. Go's
`netip.ParsePrefix` rejects a dotted IPv4 literal in the left half of a
compressed IPv6 address, so the shared IP parser now rejects forms such as
`1.2.3.4::/64`. Fixed domain/process regex constructors compile with regexp2
`IgnoreCase`; safety analysis therefore applies the same flag and conservatively
rejects `(a|A)+$`, even though the fixed binary only compiles that expression at
configuration load time. The safety analyser cannot model Unicode and
case-insensitivity together, so an IgnoreCase pattern containing a literal or
escaped caseful non-ASCII code point also rejects: Kelvin-sign and sharp-S folds
can collapse otherwise distinct alternation branches. A second adversarial pass
showed the same fold could be hidden inside `[℀-∀]` or a Unicode property class,
including direct operator schemas that reached `isSafeRuntimeRegex` without
`compileGoRegex`. The guard now lives at the shared runtime-regex boundary:
`i`+`u` rejects caseful non-ASCII literals/escapes, any class range with a
non-ASCII endpoint, and unescaped `\p`/`\P` properties. The currently unused
`i`+`v` combination rejects wholesale because UnicodeSets string classes such
as `\q` add another unmodelled ambiguity surface. Uncased literal CJK and emoji
remain supported under `i`+`u`. A later lexer differential found that the
braced-escape reader accepted only one to six written hex digits even though
ECMAScript accepts additional leading zeroes when the decoded value remains at
or below U+10FFFF. Inputs such as `\u{000212A}`, `\u{0000212A}`, and a Kelvin
escape with 64 leading zeroes therefore compiled but hid the caseful code point
from the fold guard. `readPatternCodePoint` now consumes the complete hex token,
classifies its numeric code point, and leaves empty, non-hex, or out-of-range
forms to fail closed at compilation. Filter (`iu`), rename (`giu`), and direct
runtime-guard regressions cover all three long forms. Finally, fixed
`ParseRulePayload` splits on commas, trims ASCII space from every field, and
rejoins regex and logic payloads. An independent Go probe showed `foo, bar`
becoming `foo,bar` in direct, nested, and `SUB-RULE` paths. The final renderer
compares the raw and fixed-decoded bytes for every comma-bearing
`DOMAIN-REGEX`, process-regex, `AND`, `OR`, `NOT`, and `SUB-RULE` payload
recursively and rejects any lossy form. The managed `DOMAIN-REGEX` write schema
enforces the same trim and IgnoreCase boundary.

The initial 12 fixed-binary rule fixtures remain a distinct 9-accept/3-reject
baseline. A final three-fixture delta added one rejected embedded-IPv4 prefix
and two accepted inputs: the case-folded ReDoS candidate and a nested regex
whose ASCII space fixed Mihomo silently trims. The cumulative binary ledger is
therefore 15 cases, 11 accepts and 4 rejects; fixed acceptance here describes
decoder behavior and does not override ProxyManager's fail-closed policy.

Rule-provider activation now uses the same grammar boundary. A whole-base-text
search previously found the token `RULE-SET,ads` inside
`DOMAIN-REGEX,^(RULE-SET,ads)$,DIRECT`; when a dormant remote provider named
`ads` existed, the renderer emitted its URL and turned inert regex text into an
unintended external fetch. Root cause: `renderBase` in `renderer.ts` called
`referencedProviderNamesInText(baseContent)`, which had no YAML or rule-tree
context. The corrected collector parses the YAML tree, walks only executable
ordinary rules and sub-rules with the shared fixed-rule parser, and handles the
separately evidenced DNS, fake-IP, sniffer, and TUN contexts by their actual
field grammar. The fake dormant URL now stays absent while real direct, nested,
and contextual references retain their fail-closed behavior. A follow-up found
that the contextual token matcher was still unanchored: a sniffer value such as
`foo-rule-set:ads` activated `ads`. Fixed Mihomo uses an index-zero,
case-insensitive prefix check, so embedded and leading-space forms are now inert.
The remaining split is deliberately context-specific: nameserver-policy keys
retain the full suffix when there is no comma but use the first colon segment
for a comma list, whereas sniffer and fake-IP scalar lists always use that first
segment. Empty remainder, trailing-comma, and duplicate-comma tokens are kept so
fixed lookup failure remains fail-closed. A provider named `ads` therefore
cannot make `rule-set:ads:ignored` pass when fixed Mihomo requires the distinct
name `ads:ignored`.

Provider consumption is also feature-gated in fixed Mihomo. The prior collector
read `fake-ip-filter` even under `redir-host` or the default DNS mode, and read
TUN route address sets from disabled or incomplete TUN paths. Either mistake
could emit a dormant remote provider URL or reject a harmless missing name.
Fake-IP entries are now interpreted only when `enhanced-mode` is `fake-ip`;
that mode and `fake-ip-filter-mode` use fixed Mihomo's case-insensitive enum
semantics. Root TUN sets are active only with `enable: true`,
`auto-redirect: true`, and `auto-route` either true or omitted (the fixed root
default); listener-local TUN sets require explicit true values for `auto-route`
and `auto-redirect` because their default is false.
`auto-redirect` without `auto-route` is rejected rather than accepted as a
no-op. Every active TUN route set must resolve to `behavior: ipcidr` because it
is the only strategy the pinned TUN updater applies; `domain`, `classical`,
missing, empty, or whitespace-only names all fail closed. Mode enums are
case-insensitive like the target, while booleans and list elements require exact
types: numeric `auto-route`/`auto-redirect` and numeric route-set members reject
instead of relying on fixed Mihomo's weak scalar conversion. Underscore or
case-varied listener aliases such as `auto_redirect`, `AUTO-REDIRECT`, or
`route_address_set` also reject rather than creating alias/canonical ambiguity.

A final YAML differential found that fixed Mihomo expands semantic merge keys,
while the JavaScript `yaml` AST used by the mutation and provider-reference
collectors leaves them as an unexpanded pair by default. A base skeleton could
therefore inherit executable fields without exposing them to ProxyManager's
validation. The deterministic trigger merged a DNS `nameserver-policy` that
referenced missing provider `ghost`: fixed v1.19.28 rejected the resulting
configuration, while the pre-fix collector saw only the literal `<<` pair and
missed the reference. Partial merge emulation would leave the same risk in
other inherited sections, so `parseBaseDocument` now rejects semantic merges at
the common save, parse, and stored-render boundary. The rejection is syntax
precise and mirrors go-yaml's `isMerge`: untagged plain `<<`, local-`!` `<<`,
and a key tagged `tag:yaml.org,2002:merge` reject, while quoted `"<<"`, explicit
`!!str <<`, and the equivalent JSON object key remain ordinary literal keys as
they do in the fixed target. Anchors and aliases that are not used as merge keys
remain parseable.

The final clean dependency install exposed one additional runtime boundary. The
new remote-fetch path imports `undici` directly, but its first direct package
entry was 6.25.0, inside npm's high-severity advisory range through 6.26.0. The
project now exact-pins 6.27.0 rather than accepting a caret range, and the lock
records the registry artifact integrity
`sha512-YmfV3YnEDzXRC5lZ2jWtWWHKGUm1zIt8AhesR1tens+HTNv+YZlN/dp6G727LOvMJ8xjP9Be7Y2Sdr96LDm+pg==`.
That release declares Node `>=18.17`, so it remains inside this project's Node
22 contract. A clean `npm ci` followed by `npm ls undici` resolves the direct
dependency to 6.27.0, and the post-fix direct vulnerable list no longer includes
`undici`. This is a scoped repair, not a claim that the repository-wide audit is
clean: 37 existing Next/Vercel/transitive advisories remain separately recorded
with zero critical findings.

Residual risk is fail-closed. Proxy-group preview intentionally supports only
the ReDoS-checked JS/regexp2 common subset, so a valid but unpreviewable fixed
regexp2 expression may require simplification. The nameserver validator is
likewise a conservative subset of the pinned parser and can reject an advanced
but loadable form; no live DNS or VPN handshake was attempted. A target-version
upgrade therefore requires re-pinning both grammars and their binary fixtures,
not silently widening either input surface. The provider collector is likewise
an explicit finite context map: a new Mihomo rule-set-bearing context must be
added with a source anchor and positive/opaque-negative regressions before it is
allowed to activate a provider.

## Required detail for P0/P1

Each P0/P1 entry must include a minimal fake-credential reproduction, one-sentence
root cause naming a file/function/condition, official or fixed-source evidence,
a regression test that fails before the fix, full-chain validation, and residual
risk.
