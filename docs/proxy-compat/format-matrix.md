# Input and output format matrix

The matrix distinguishes syntactic readability from a product support promise.
For example, a YAML parser accepting JSON does not imply support for arbitrary
Xray or sing-box JSON object shapes.

| Format                                                        | Recognition rule                                                                                                                     | Product contract                                                                                          | Safe conversion target                                                          | Loss/error policy                                                                                                                       | Validation                                                                                                                                                                                                                                                                                                     | Status                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Full Mihomo YAML supplied as a subscription                   | YAML mapping whose `proxies` value is an array                                                                                       | Supported as a **node source**, not as a second base config                                               | Provider YAML, collection export, injected `proxies` in the final Mihomo config | All non-`proxies` top-level keys are deliberately discarded; node order and scalar values remain, comments and YAML presentation do not | Runtime: closed fixed-v1.19.28 top-level schemas and exact primitive types for 24 portable proxy types, plus nested and semantic invariants at every delivery boundary. Audit: representative generated full configs use checksum-pinned Mihomo; this is not a complete reimplementation of every constructor. | Supported with documented loss |
| Mihomo provider YAML                                          | YAML mapping whose `proxies` value is an array                                                                                       | Primary structured subscription format                                                                    | Same as above                                                                   | Reject the whole source for a malformed entry; never filter invalid siblings                                                            | Runtime: the same closed top-level and nested validator before cache, operators, export, and final render. Audit: direct/cache/stale/operator/final-render tests and representative checksum-pinned Mihomo fixtures.                                                                                           | Supported                      |
| Single-node YAML or JSON object                               | A mapping without a top-level `proxies` array                                                                                        | Not supported                                                                                             | None                                                                            | Return the fixed unsupported-format error; do not guess a wrapper                                                                       | Normaliser negative probes                                                                                                                                                                                                                                                                                     | Explicitly unsupported         |
| JSON object with `proxies`                                    | Parsed by `yaml@2.9.0`, then the same array rule                                                                                     | Supported only because it is an unambiguous provider-shaped document; this is not generic JSON conversion | Mihomo provider/full config                                                     | Same node validation and whole-source rejection as YAML                                                                                 | JSON-as-YAML unit probe plus target validation                                                                                                                                                                                                                                                                 | Supported provider shape       |
| URI list                                                      | At least one non-comment line begins with one of the 17 registered schemes; every nonblank, noncomment line must then be a proxy URI | Supported for the 13 parser families in `protocol-matrix.md`                                              | Canonical Mihomo provider nodes                                                 | Any recognised or ordinary sibling-line error rejects the entire list; diagnostics retain only line number and scheme                   | Per-family parser tests, normaliser tests, full-chain fixture and fixed Mihomo                                                                                                                                                                                                                                 | Supported, protocol rows vary  |
| URI list with comments                                        | Blank lines and lines whose trimmed form begins `#` or `//` are ignored                                                              | Supported                                                                                                 | Same as URI list                                                                | A noncomment prose line is an error, not an implicit comment                                                                            | CRLF/LF/comment metamorphic tests                                                                                                                                                                                                                                                                              | Supported                      |
| One-layer Base64 URI list                                     | Entire trimmed body is strict standard or URL-safe Base64; padding may be canonical or omitted and decoded UTF-8 must be valid       | Supported, exactly one decode layer                                                                       | Same as URI list                                                                | Reject malformed alphabet/padding, invalid UTF-8, double wrapping, and decoded partial URI lists; no permissive prefix decode           | Base64 table tests and normaliser/cache tests                                                                                                                                                                                                                                                                  | Supported after strict decode  |
| One-layer Base64 provider/full YAML                           | Same strict one-layer decode, followed by the structured `proxies` rule                                                              | Supported                                                                                                 | Mihomo provider/full config                                                     | Same deliberate top-level loss and node rejection as direct YAML; double Base64 is not recursively decoded                              | Fetcher tests for full and provider YAML                                                                                                                                                                                                                                                                       | Supported after strict decode  |
| JSON5                                                         | No JSON5 parser exists; `yaml` happens to accept a non-identical subset such as some flow mappings                                   | Not promised                                                                                              | None                                                                            | Do not label incidental YAML grammar as JSON5 support; ambiguous inputs may be rejected                                                 | Characterisation probes                                                                                                                                                                                                                                                                                        | Explicitly not promised        |
| Xray JSON (`outbounds`)                                       | No adapter/recogniser                                                                                                                | Research-only comparison target                                                                           | None until a neutral semantic model and Xray adapter are designed               | Return unsupported; never reinterpret an outbound as Mihomo fields by name                                                              | Fixed Xray source/binary comparison                                                                                                                                                                                                                                                                            | Explicitly unsupported input   |
| sing-box JSON (`outbounds`/`endpoints`)                       | No adapter/recogniser                                                                                                                | Research-only comparison target                                                                           | None until a target adapter exists                                              | Return unsupported; target-specific nested TLS/transport fields are not portable                                                        | Fixed sing-box source/binary comparison                                                                                                                                                                                                                                                                        | Explicitly unsupported input   |
| v2ray-core JSON                                               | No adapter/recogniser                                                                                                                | Research-only comparison target                                                                           | None                                                                            | Return unsupported; Xray VLESS Encryption values are rejected by fixed v2ray-core                                                       | Fixed v2ray-core binary comparison                                                                                                                                                                                                                                                                             | Explicitly unsupported input   |
| Surge/Loon/Quantumult X/Stash/Egern/Shadowrocket line formats | No line parser                                                                                                                       | Ecosystem research only                                                                                   | None until an evidenced dialect is deliberately implemented                     | Return unsupported instead of applying URI heuristics                                                                                   | Fixed open-source/client evidence where available                                                                                                                                                                                                                                                              | Explicitly unsupported input   |
| WireGuard `.conf`                                             | No INI/WireGuard parser                                                                                                              | Research-only; `wireguard://`/`wg://` are separate ecosystem URI dialects                                 | None                                                                            | Return unsupported; do not flatten repeated `[Peer]` sections into one URI peer                                                         | WireGuard `wg(8)` grammar and Mihomo structural probes                                                                                                                                                                                                                                                         | Explicitly unsupported input   |

## Entry-point and resource boundaries

- Subscription content is not the base skeleton. A full config used as a node
  source contributes only `proxies`; the separately managed base, rules, groups,
  and rule providers remain authoritative.
- Local inline subscription content is schema-capped at 4 MiB. Remote content
  is capped at 10 MiB using both declared-length and streaming overflow checks,
  and is decoded as fatal UTF-8 before parsing.
- A URI-list body is rejected before parsing when it exceeds 50,000 physical
  lines. Every structured or merged proxy list is rejected above 50,000 nodes.
  Hysteria/Hysteria2 `ports` accepts at most 28 segments per node and the whole
  delivered list is rejected when its port sets expand beyond 65,536 candidate
  ports. Both H1 and H2 structured nodes may use `ports` without a scalar
  `port`; those ports-only forms were accepted by the fixed Mihomo binary.
- Scalars that the target converts from seconds to signed Go durations stop at
  9,223,372,036. AnyTLS retained sessions and WireGuard workers stop at 256;
  XHTTP session ID endpoints and range cardinality also stop at 256. The same
  resource bounds apply to URI and structured provider input.
- Structured OpenVPN, WireGuard, and MASQUE may enable remote DNS only together
  with a non-empty list of nameservers in the conservative fixed-target grammar.
  The flat WireGuard URI dialect has no `dns[]` carrier, so its
  `remote-dns-resolve` query rejects. OpenVPN `udp` also rejects because the
  fixed constructor ignores the decoded option.
- Direct input, fresh fetch, fetch-cache hit, stale fallback, provider export,
  collection export, and final render use the same node-validation contract.
  Operators are followed by a second validation so they cannot create an empty
  name or invalid scalar after the initial source check.
- Chain wrapping is followed by validation of the complete
  base+subscription+clone proxy list. A multi-member `dialer-proxy` wrap, a
  wrap name colliding with an existing proxy, a cross-source dangling/cyclic
  dialer graph, or a post-clone resource-limit breach therefore fails the whole
  render instead of producing a warning and an unloadable config.
- The materialized final document is then checked across sections. Proxy-group
  members and `use` providers, concrete-proxy `dialer-proxy` targets, and final
  rule policies must resolve; group membership must be acyclic and retain a
  member source. Proxy/group/provider names may not collide with one another or
  Mihomo-reserved names. Only the fixed target's `select`, `url-test`,
  `fallback`, and `load-balance` group types are admitted, so removed `relay`
  groups reject before publication. A dynamic group with no explicit member
  receives `empty-fallback: REJECT` unless a concrete fallback was explicitly
  configured. Include-all groups automatically append an anchored chain-clone
  exclusion as a separate backtick-delimited regexp2 pattern, preserving any
  user `exclude-filter` while preventing a generated clone from re-entering its
  own dialer path.
- Every user-controlled operator, proxy-group, or final-rule regex that reaches
  JavaScript is limited to the ReDoS-checked JS/regexp2 common subset. Programs
  and candidate node names stop at 512 characters. Fixed domain/process rule
  constructors force `IgnoreCase`; under that flag, literal or escaped caseful
  non-ASCII code points reject because the analyser cannot soundly combine
  Unicode folding with its case-insensitive mode. The escape decoder consumes a
  complete braced Unicode token, including long leading-zero forms, before
  classifying its decoded code point. Under `i`+`u`, non-ASCII class ranges and
  unescaped Unicode property classes also reject because they can hide folding
  members without spelling them. `i`+`v` rejects wholesale because UnicodeSets
  string classes add another unmodelled surface. Uncased literal CJK and emoji
  remain admitted under `i`+`u`. This is intentionally narrower than every regex
  the fixed binary can compile.
- The fetch cache stores normalized provider YAML. Parser-semantic changes must
  bump both `FETCH_CACHE_EPOCH` and `RENDER_CACHE_EPOCH`; otherwise one of the
  two cache layers can bypass the new parser.
- Fetch and render cache envelopes are runtime-validated. Empty/malformed
  payloads, mismatched content-derived build IDs, future timestamps, freshness
  windows above 24 hours, and malformed metadata are misses. A present-invalid
  global `config:version` cannot read or write a legacy generation-zero entry;
  repair uses compare-and-set semantics and cannot overwrite a concurrent valid
  increment.
- A base skeleton rejects semantic YAML merge syntax before save or render.
  Fixed Mihomo expands untagged plain `<<`, local-`!` `<<`, and explicitly
  merge-tagged keys, whereas the JavaScript AST mutation pipeline does not;
  accepting one could hide inherited rules or provider references from
  validation. Quoted `"<<"`, explicit `!!str <<`, and the equivalent JSON object
  key remain ordinary literals, and non-merge anchors/aliases remain parseable.
- Active proxy groups require the `PROXY-GROUPS` marker. Every final rule-set
  reference must resolve to the managed library: ordinary rules and sub-rules;
  `rule-set:` expressions in both DNS nameserver-policy maps; fake-IP filter
  entries only under fake-IP enhanced mode; sniffer force/skip domain and
  source/dest address lists; and `route-address-set` or
  `route-exclude-address-set` only on active TUN auto-route+auto-redirect paths.
  Root TUN treats omitted `auto-route` as its fixed-target true default;
  listener-local TUN requires explicit `true` for both booleans. Domain contexts
  reject `ipcidr` providers, while ordinary IP contexts reject `domain`; TUN
  route sets require exactly `ipcidr`. Active providers require the
  `RULE-PROVIDERS` marker. Missing markers, unknown or
  context-incompatible rule sets fail before a cache write. Provider discovery
  follows the parsed rule tree and these exact YAML contexts; comments, opaque
  scalars, and `RULE-SET`-looking regex text are not treated as live references.
  Contextual forms require the case-insensitive `rule-set:` prefix at index zero
  and preserve fixed Mihomo's distinct nameserver-policy versus
  sniffer/fake-IP colon/comma split semantics. Mode strings are matched
  case-insensitively, but booleans and route-set elements require exact runtime
  types rather than copying fixed Mihomo's weak scalar coercion. Root or
  listener `auto-redirect` without an effective `auto-route`, noncanonical
  listener aliases, and active empty or no-op route-set forms reject.

## Deliberate serialization loss

YAML comments, anchors used only for presentation, quoting style, key order,
and numeric spelling are not preserved when a subscription is normalized and
serialized. That is acceptable only because the subscription contract is an
array of node objects, not a round-trip YAML editor. Semantic scalar types and
byte-sensitive strings must remain unchanged; lossy coercion of a credential,
key, transport, or security field is an error.
