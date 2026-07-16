# Proxy URI and subscription compatibility audit

Audit date: 2026-07-15

This directory records the evidence, compatibility matrices, findings, fixes,
and validation results for the path from proxy-node input to rendered Mihomo
configuration.

## Scope

- Proxy URI schemes and aliases accepted by `web/lib/proxies/uriToClash.ts`
- Subscription/container recognition in `web/lib/services/subscriptionFetcher.ts`
- Provider and full-config rendering, validation, export, and cache behaviour
- Mihomo as the committed output target
- Xray-core, sing-box, v2ray-core, Sub-Store, and selected clients as comparison
  targets only unless the product already promises their format

## Evidence policy

Important conclusions must be backed, in order of preference, by a protocol
specification, official target documentation, source at a fixed commit, or a
fixed official binary. Ecosystem converters and client implementations are
interoperability evidence, not protocol standards.

## Reading order

1. [sources.md](sources.md)
2. [protocol-matrix.md](protocol-matrix.md)
3. [parameter-matrix.csv](parameter-matrix.csv)
4. [format-matrix.md](format-matrix.md)
5. [findings.md](findings.md)
6. [validation.md](validation.md)
7. [remaining-gaps.md](remaining-gaps.md)

Agent research drafts live under `workstreams/`. The integrated documents above
are the source of truth after independent review.

## Counting rules

- A scheme is a case-insensitive URI prefix registered as accepted input.
- A parser is one independently dispatched protocol family, not every alias.
- A raw key is the exact spelling observed in an accepted input format.
- An alias is an additional raw spelling that maps to an already counted
  semantic parameter.
- A canonical semantic is a protocol-scoped meaning after alias and scalar
  normalization; identically named fields in different protocols remain
  separate unless their semantics and defaults are demonstrably identical.
- A nested parameter is a separately addressable field below an object-valued
  parameter, including XHTTP, smux, Reality, WireGuard peer, and plugin options.
- Test coverage is counted only when an assertion reaches the parameter mapping
  or rejection path; merely parsing the containing node does not count.

## Exact static inventory at the audit baseline (historical research draft)

- 17 registered URI scheme spellings dispatched case-insensitively
- 13 independently dispatched parser families
- 4 secondary spellings sharing a parser: `hy2`, `wg`, `socks`, `https`
- 127 protocol-location top-level named raw-key occurrences
- 73 unique finite top-level raw spellings
- 60 nested raw leaf occurrences
- 108 unique finite spellings across top-level and nested leaves
- 56 statically named top-level Mihomo output fields
- 12 of 13 parser families had direct baseline tests; Hysteria 1 had none

At that baseline, AnyTLS and WireGuard accepted wildcard query passthrough after
underscore-to-dash normalisation, so their runtime raw-name and alias sets were
unbounded. Those statements are retained only to explain the original finding;
they do **not** describe the final worktree. Counts above are frozen at commit
`9596cec88fb17fd67ed7102b625b18bb92e9f68f`.

## Final bounded inventory

The final machine-readable matrix has 21 columns and 295 data rows. It retains
the same 17 registered scheme spellings and 13 parser families, but both former
wildcards and every other parser family now use a closed grammar. Its 193
finite parameter rows contain 133 top-level query/JSON rows and 60 nested rows,
233 explicit spelling occurrences, 139 globally unique spellings, and 150
unique canonical semantics. Final finite statuses are 161 `complete`, 28
`explicit_reject`, 4 deliberately documented `partial`, and zero
`silent_drop`/`unknown`; whole-matrix statuses are 239 `complete`, 50
`explicit_reject`, 6 `partial`, and zero `silent_drop`/`unknown`.

Resource and final-delivery boundaries are also part of the compatibility
contract: URI input is capped at 50,000 physical lines; every validated node
list is capped at 50,000 nodes; Hysteria/Hysteria2 `ports` accepts at most 28
segments per node and all port sets in a delivered list share a 65,536 expanded
candidate budget. Fixed-target duration seconds stop at 9,223,372,036;
AnyTLS retained sessions and WireGuard workers stop at 256; XHTTP session
length/range endpoints and cardinality stop at 256. Structured OpenVPN,
WireGuard, and MASQUE remote DNS requires a paired, non-empty and conservatively
parsed nameserver list; the flat WireGuard URI cannot represent that pair and
therefore rejects `remote-dns-resolve`. OpenVPN `udp` rejects as a fixed-target
constructor no-op. After chain clones are materialised, the complete
base+subscription+clone proxy list is validated again, so global name,
`dialer-proxy`, cycle, node-count, and Hysteria-port invariants cannot be
bypassed by merging stages.
Every user-controlled regex that ProxyManager evaluates or previews is limited
to the ReDoS-checked JavaScript/regexp2 common subset with 512-character program
and input bounds. Fixed domain/process rule regexes are analysed with their
mandatory `IgnoreCase`; literal or escaped caseful non-ASCII code points reject
under that flag because the analyser cannot soundly model Unicode folds. Escaped
forms include braced Unicode tokens with arbitrarily many leading zeroes, which
ECMAScript accepts when the decoded value remains a valid code point. Under
`i`+`u`, non-ASCII class ranges and Unicode property escapes also reject because
they can hide a folding member without spelling it; `i`+`v` rejects wholesale
because UnicodeSets string classes add another unmodelled surface. Uncased
literal CJK and emoji remain usable under `i`+`u`.
The materialized document must also resolve group members/providers, final rule
policies, and rule-set references across ordinary rules and sub-rules, DNS
policies, fake-IP filters only in fake-IP enhanced mode, sniffer domain/IP
lists, and active TUN auto-route+auto-redirect address sets. Root TUN treats an
omitted `auto-route` as its fixed-target true default; listener-local TUN
requires both booleans explicitly true. TUN route providers must use `ipcidr`
behavior. It preserves an acyclic group graph with a
member source, avoids cross-kind/reserved name collisions, and uses only
fixed-target group types (`relay` is rejected). Dynamic groups without explicit
members receive a fail-closed `empty-fallback: REJECT` unless the user selected
another concrete fallback; include-all groups automatically exclude generated
chain clones so those clones cannot be pulled back into their own dialer path.
Provider activation follows the parsed rule tree and evidenced YAML contexts;
`RULE-SET`-looking text inside a regex, comment, or opaque scalar stays inert.
Contextual forms require a case-insensitive `rule-set:` prefix at index zero;
the nameserver-policy and sniffer/fake-IP colon/comma rules are preserved rather
than collapsed into one generic substring matcher. Fake-IP entries stay inert
outside fake-IP enhanced mode; disabled TUN and listener-local paths without
both booleans stay inert. Root or listener `auto-redirect` without an effective
`auto-route`, active no-op combinations, weakly typed booleans/list members, and
noncanonical listener aliases reject.
Semantic YAML merge keys are also rejected at the shared base parse boundary:
fixed Mihomo expands them, but the JavaScript AST mutation pipeline does not.
This prevents an inherited rule or contextual provider reference from bypassing
collection. Untagged plain `<<`, local-`!` `<<`, and explicit YAML merge tags
reject; quoted `"<<"`, explicit `!!str <<`, and the equivalent JSON key remain
ordinary literals, matching the fixed target.
The direct fetch client is exact-pinned to patched `undici` 6.27.0 after the
initial 6.25.0 pin fell inside npm's high-severity advisory range. This scoped
repair does not hide the repository's 37 remaining Next/Vercel/transitive audit
findings (3 low, 10 moderate, 24 high, 0 critical), which remain explicit debt.

Exact formulas, per-family subtotals, coverage markers, current hashes, and a
standard-library reproduction script live in
[workstreams/parameter-counts.md](workstreams/parameter-counts.md).
