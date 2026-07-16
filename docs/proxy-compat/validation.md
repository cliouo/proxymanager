# Validation ledger

## Initial baseline

Run from `web/` at clean `9596cec88fb17fd67ed7102b625b18bb92e9f68f` on
2026-07-15. Runtime was Node 22.22.3 and npm 10.9.8, matching the Node 22.x
contract declared by `package.json`.

| Command                                            | Result                             | Baseline classification                                  |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `npm test -- tests/subscriptions/proxyUri.test.ts` | PASS: 75 tests                     | Clean baseline                                           |
| `npm test`                                         | PASS: 43 files, 485 tests          | Clean baseline                                           |
| `npm run typecheck`                                | PASS                               | Clean baseline                                           |
| `npm run lint`                                     | FAIL: 3 errors, 6 warnings         | Pre-existing; errors are in `scripts/skillopt/scorer.ts` |
| `npm run format:check`                             | FAIL: 107 files                    | Pre-existing repository-wide formatting drift            |
| `npm run build`                                    | PASS: Next.js 16.2.6 webpack build | Clean baseline                                           |
| `git diff --check`                                 | PASS                               | Clean baseline                                           |

The audit format-checked changed files separately so existing global drift could
not hide new violations. Final validation reran every required command and
compared its result with this baseline.

## Runtime dependency audit

The final clean install initially placed direct runtime `undici@6.25.0` in
npm's high-severity advisory range `<=6.26.0`. The repaired manifest exact-pins
6.27.0, whose registry metadata declares Node `>=18.17`, and the lock records
integrity
`sha512-YmfV3YnEDzXRC5lZ2jWtWWHKGUm1zIt8AhesR1tens+HTNv+YZlN/dp6G727LOvMJ8xjP9Be7Y2Sdr96LDm+pg==`.
A clean `npm ci` succeeded, `npm ls undici` resolved the direct dependency to
6.27.0, and the post-fix direct vulnerable list did not contain `undici`.

The repository-wide audit is not clean and is not presented as such. It still
reports 37 existing framework/toolchain/transitive findings: 3 low, 10
moderate, 24 high, and 0 critical. They originate in existing Next/Vercel and
transitive paths outside the scoped fetch-client repair. No automatic major
downgrade or unrelated audit rewrite was applied; the residual upgrade work is
recorded in [remaining-gaps.md](remaining-gaps.md).

The production-only view (`npm audit --omit=dev`) reports two moderate findings,
zero high or critical findings, and no Undici finding. The full clean install
added 774 packages and audited 775. `npm ls --depth=0` exited zero with direct
Undici 6.27.0; five npm-created optional-WASM entries appeared as extraneous in
`node_modules` but are not tracked by Git.

## Final repository gates

Run from `web/` on the twice-reviewed frozen source snapshot after clean
`npm ci`, using Node 22.22.3 and npm 10.9.8. This runtime matches the declared
Node 22.x contract.

| Command or gate                                           | Final result                                                                                                                       | Baseline comparison or boundary                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                  | PASS: 774 packages installed, 775 audited                                                                                          | Clean lockfile reconstruction                                                                                                           |
| `npm ls --depth=0`                                        | PASS: direct `undici@6.27.0`; 5 optional-WASM entries reported extraneous                                                          | Optional entries are npm-created and untracked; installed direct dependency is the exact patched pin                                    |
| `npm run build:skills` twice                              | PASS: both generated SHA-256 `6495da617277b10b2c57f0f11287f8cb45cf011f368b5e9e20a51bf187c8a364`; generated Prettier check passed   | Deterministic generated plugin/skill artifact                                                                                           |
| `npm test -- tests/subscriptions/proxyUri.test.ts`        | PASS: 1 file, 348 tests                                                                                                            | Required targeted parser gate; baseline was 75 tests                                                                                    |
| Latest-snapshot focused independent Vitest suite          | PASS: 12 files, 1,036 tests                                                                                                        | Full request boundaries plus Unicode/context/merge/dependency regressions                                                               |
| `npm test`                                                | PASS: 52 files, 1,360 tests                                                                                                        | Baseline was 43 files/485 tests; no new failure                                                                                         |
| `npm run test:coverage`                                   | PASS: statements 77.61% (6,317/8,139), branches 72.36% (4,658/6,437), functions 74.72% (822/1,100), lines 80.14% (5,736/7,157)     | Required coverage gate completed without threshold failure                                                                              |
| `npm run typecheck`                                       | PASS                                                                                                                               | Baseline passed                                                                                                                         |
| Changed/untracked web and plugin ESLint                   | PASS                                                                                                                               | Scoped proof that this audit adds no lint error                                                                                         |
| `npm run lint`                                            | BASELINE FAIL: 3 errors and 5 warnings; all 3 errors remain only in unchanged `scripts/skillopt/scorer.ts`                         | Baseline had the same 3 errors and 6 warnings; no new error, one fewer warning                                                          |
| Changed web/plugin Prettier check                         | PASS                                                                                                                               | All files changed by the audit are formatted                                                                                            |
| `npm run format:check`                                    | BASELINE FAIL: 82 unchanged files                                                                                                  | Baseline had 107 files; no changed-file regression                                                                                      |
| `npm run build`                                           | PASS: Next.js 16.2.6 production build; 20 static pages and every route built                                                       | Baseline build passed                                                                                                                   |
| `git diff --check`                                        | PASS                                                                                                                               | Final frozen worktree, including documentation                                                                                          |
| `git status --short`, `git diff --stat`, `git diff`       | INSPECTED                                                                                                                          | Original dirty state and unrelated user assets preserved; no commit, push, binary, cache, real subscription, or production secret added |
| `npm audit`                                               | EXPECTED NONZERO: 37 findings — 3 low, 10 moderate, 24 high, 0 critical; direct Undici finding cleared                             | Existing Next/Vercel/transitive upgrade debt is explicitly isolated; no automatic unrelated major fix                                   |
| `npm audit --omit=dev`                                    | EXPECTED NONZERO: 2 moderate, 0 high, 0 critical; Undici absent                                                                    | Production-only residual boundary                                                                                                       |
| Independent safe-fetch/runtime probes                     | PASS: `safeFetch` 18/18 and dispatcher runtime returned HTTP 200/`ok`                                                              | No remaining fetch-path blocker                                                                                                         |
| Fixed Mihomo full configs / provider boundaries / clients | PASS: 6/6 full fixtures; 15/15 provider outcomes (11 target accepts/4 rejects); 13/13 Xray/sing-box/v2ray-core comparison outcomes | Weak numeric inputs accepted by the core remain intentional product rejects; binary hashes are unchanged                                |

## Fixed binary ledger

| Target     | Version                              | Commit/checksum                                                                                                                                                                                                                                                   | Command                                          | Result                                                                                                                             | Notes                                                                                                                                                                                                                  |
| ---------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mihomo     | `v1.19.28`, Darwin arm64, Go 1.26.5  | release asset `mihomo-darwin-arm64-v1.19.28.gz` SHA-256 `40cdae2fab4b18df15f40eaa9dc3af70ab3d8be7f77164ae1e5f1af3a2a4fb44`; unpacked binary `55b7286331cb30a54b2564013b02b84a0c280e8b690bd1e5da4b9d4f4ca007ac`; source `cbd11db1e13a75d8e680e0fe7742c95be4cba2be` | `mihomo -t -d <temp-home> -f <full-config.yaml>` | PASS: 6/6 generated full configs, including all 13 parser families, both HTTPUpgrade mappings, and three end-to-end delivery paths | No separate checksum asset was published; the GitHub release API asset digest exactly matched the local SHA-256, which two audit workstreams also reproduced. Provider YAML is wrapped in a complete synthetic config. |
| Xray-core  | `v26.3.27`, Darwin arm64, Go 1.26.1  | asset SHA-256 `2e93a67e8aa1936ecefb307e120830fcbd4c643ab9b1c46a2d0838d5f8409eaf`, exactly matching the official `.dgst`; binary `5d9dd24c0aba4b6cfcc6a33a5d67f854816ee17f392bf932ec8176da46f7e404`; source `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0`             | `xray run -test -c <config.json>`                | PASS: all 5 VLESS encryption cases matched the expected accept/reject boundary                                                     | Version output included commit prefix `d2758a0`; generated public encryption values stayed in mode-`0600` temporary files and were never printed.                                                                      |
| sing-box   | `v1.13.14`, Darwin arm64, Go 1.25.11 | asset SHA-256 `73e8967b0fc08e17bce4263ca56ebc394822401a16497a1c4e02316c888202ab`; binary `813d8effd02a19572a8d75aef29fc073101404ca535b2496be86f21827c7684d`; source `25a600db24f7680ad9806ce5427bd0ab8afe1114`                                                    | `sing-box check -c <config.json>`                | PASS: all 3 VLESS structure cases matched the expected accept/reject boundary                                                      | No separate checksum asset was exposed; the GitHub release API digest matched the local SHA-256 and version output reported the full expected revision.                                                                |
| v2ray-core | `v5.51.2`, Darwin arm64, Go 1.26.1   | asset SHA-256 `16203112011008b3129fb4e829bd29733173e8559539b77af6df8d003a12c4fe`, exactly matching the official `.dgst`; binary `3770bb74e58f93b28c0c35e0f52007c0787827532148e74eac6ab1349640a7fd`; source `59950bd0b02c482ee88f4c7fe1aeb1e48db7e286`             | `v2ray test -c <config.json>`                    | PASS: all 5 VLESS encryption cases matched the expected accept/reject boundary                                                     | Current v5 CLI form, not the obsolete `-test -config` form.                                                                                                                                                            |

Host: macOS 26.3 (`Darwin arm64`). Downloads and extracted binaries live only
under `/tmp/proxymanager-proxy-audit-20260715`; no binary is committed. The
reproducible Mihomo fixtures are generated by
`web/scripts/proxy-compat/generate-mihomo-fixtures.ts` and validated by
`web/scripts/proxy-compat/validate-mihomo-fixtures.ts`.

No real credentials, subscriptions, or production configuration may be used in
fixtures or binary validation.

## Mihomo full-chain fixtures

The reproducible generator produced six complete configs, and the fixed binary
accepted all six:

| Fixture                             | Nodes | Boundary exercised                                                                                                                                                                         |
| ----------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `all-uri-families.yaml`             |    13 | One fake URI for each independent parser family; exact type set `ss`, `ssr`, `vmess`, `vless`, `trojan`, `hysteria`, `hysteria2`, `tuic`, `snell`, `anytls`, `wireguard`, `socks5`, `http` |
| `vless-security-transport.yaml`     |     6 | Default/explicit XUDP, packetaddr, Reality, VLESS Encryption, and nested XHTTP download settings                                                                                           |
| `http-upgrade.yaml`                 |     2 | VMess and VLESS HTTPUpgrade canonicalized to `network: ws` with explicit `v2ray-http-upgrade`; early data enables the target fast-open flag                                                |
| `full-chain-local.yaml`             |    13 | Local URI subscription -> normalizer -> per-source `set-prop` operator -> final renderer                                                                                                   |
| `full-chain-collection.yaml`        |    13 | Local URI subscription -> collection binding -> collection sort operator -> final renderer                                                                                                 |
| `full-chain-collection-export.yaml` |    13 | Collection node export -> provider YAML parse -> complete synthetic config                                                                                                                 |

The two collection outputs were sorted by name; the direct/local outputs kept
source order. A structural inspection confirmed non-empty names and the exact
type/count sets without printing credential fields. Cache hit/miss, stale,
`noCache`, corrupt-envelope, and fail-closed source behaviour are covered in the
automated repository/service suites rather than encoded into binary fixture
names.

The automated XHTTP parser table additionally covers strict root/nested header
objects, the `uplinkHTTPMethod` compatibility alias and `GET`/`packet-up`
constraint, materialized padding defaults, predefined session-table expansion,
the 256 length/range limits and minimum identifier space, and the positive
`maxConnections`/`maxConcurrency` conflict. Xray's three integer POST/chunk
inputs are emitted as exact decimal strings required by fixed Mihomo; zero
`uplinkChunkSize` rejects before it can reach the runtime chunk loop. These are
trust-boundary checks; the fixed fixture confirms the resulting supported
structure still loads.

## Fixed Mihomo rule-boundary probes

Twelve `rule-edge-*.yaml` synthetic configs under the temporary audit directory
were checked with the pinned Mihomo binary. Nine loaded:
`domain-weird`, `dscp-overflow`, `dscp-star`, `ipcidr-v6`, `ipcidr6-v4`,
`match-extra`, `nested-logic-valid`, `param-unknown`, and `port-overflow`. Three
rejected: `nbsp-target`, `regex-empty-class` (`[]`), and `regex-neg-empty`
(`[^]`). The nine accepts characterize fixed
decoder behavior, including ignored or narrowed values; they are **not** a
ProxyManager support promise. Product schemas intentionally reject unsafe,
ignored, or lossy members of that set before render. A separate Go
`netip.ParsePrefix` probe rejected leading-zero prefix bits; it was not a YAML
fixture and is not included in the 12-case total.

A final three-fixture delta exercised the remaining fixed-rule boundaries.
`invalid-embedded-v4` rejected, while `ignorecase-redos` and
`nested-regex-space` loaded. The first result pins Go `netip`'s placement rule;
the two accepts show that fixed Mihomo only compiles the case-insensitive regex
and silently removes the ASCII space from the nested comma payload. Together
with the initial set, the binary ledger is 15 cases: 11 accept and 4 reject.
ProxyManager deliberately rejects all three risky input shapes before render.
An independent Go `ParseRulePayload` probe additionally confirmed that direct,
nested logic, and `SUB-RULE` payloads containing `foo, bar` are all normalized
to `foo,bar`; the final renderer therefore compares raw versus fixed-decoded
bytes recursively for every comma-bearing regex, `AND`, `OR`, `NOT`, and
`SUB-RULE` payload. Managed `DOMAIN-REGEX` writes apply the same trim check, and
both managed and literal regex paths run the ReDoS gate with fixed Mihomo's
forced `IgnoreCase` flag. Because the detector cannot soundly combine Unicode
and case-insensitive analysis, literal or escaped non-ASCII code points that
participate in case folding also reject under IgnoreCase. An adversarial class
range with uncased written endpoints still hid the Kelvin-sign fold, and a
Unicode property class hid it without spelling any member. The central
`i`+`u` guard therefore also rejects non-ASCII class ranges and unescaped
property escapes. `i`+`v` rejects wholesale because UnicodeSets string classes
such as `\q` add another unmodelled ambiguity surface. Kelvin-sign/sharp-S
literal, fixed-width escape, range, and property regressions fail closed across
operator, proxy-group, managed-rule, and final literal-rule paths. The escape
reader also consumes the whole ECMAScript braced token: `\u{000212A}`,
`\u{0000212A}`, and a form with 64 leading zeroes decode to the Kelvin sign and
reject through filter (`iu`), rename (`giu`), and direct runtime-guard paths.
Uncased literal CJK and emoji controls remain accepted under `i`+`u`. An
independent oracle fuzz then covered 2,985 caseful code points in 9,018 regular
encodings and 8,955 seven-, eight-, or 64-leading-zero braced encodings without
finding another bypass; 614 astral surrogate-pair controls also retained their
intended boundary. Before the fix, a synthetic property-class attack over
24, 28, and 32 Kelvin signs took
approximately 1.7, 11.6, and 83.6 ms respectively, demonstrating exponential
growth without using any external data.

The remote-DNS binary set has one separate fixture,
`openvpn-invalid-dns.yaml`: fixed Mihomo rejected it 0/1 because the shared
nameserver parser refused OpenVPN `dns[0]` value `not a nameserver`. The
WireGuard and MASQUE pair/grammar conclusions are pinned to their fixed-source
call sites and the 384-case validator suite; no additional binary fixture is
counted for those two types.

## Mihomo provider boundary probes

`web/scripts/proxy-compat/validate-mihomo-provider-boundaries.ts` wraps each
synthetic node in a complete config and checks the expected result. All 15
cases matched the fixed binary:

| Fixed Mihomo result                   | Cases                                                                                                                                                             | Product conclusion                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACCEPT (8)                            | Valid SS, valid VLESS, unauthenticated Hysteria 2, Hysteria 1 ports-only, Hysteria 2 ports-only, flat one-peer WireGuard, bounded custom VMess user ID, Tailscale | The first seven are positive controls. The custom ID confirms the fixed target extension that ProxyManager canonicalizes to UUIDv5; Tailscale remains rejected without a declared deployment capability.  |
| REJECT (4)                            | Unknown type, policy group used as a proxy, SS without cipher/password, Rematch without a target                                                                  | These are constructor/load failures and are rejected before cache, operators, export, or render.                                                                                                          |
| ACCEPT despite noncanonical input (3) | Numeric-string port, numeric server, port 70000                                                                                                                   | Mihomo's weak decoder is intentionally not copied. ProxyManager requires a string server and an integer port in `1..65535` so provider data cannot silently change type or construct an invalid endpoint. |

The local validator uses closed top-level field schemas and exact primitive
types for all 24 portable proxy types in the fixed registry; unknown fields and
weak decoder coercions reject before delivery. Endpoint-free `direct`/`dns`
admit only the fixed local routing controls (`tfo`, `mptcp`, `interface-name`,
`routing-mark`, and `ip-version`) and reject `dialer-proxy`/smux; `reject` and
`rematch` reject all common endpoint/smux controls. It also closes common smux,
TLS/ECH/Reality, transport, Shadowsocks plugin, WireGuard peer/Amnezia, Snell
obfs, Hysteria2 Realm, Trojan SS, Sudoku HTTP-mask, and TLS-mirror nested
objects. TLS-only fields, including VMess/VLESS Reality or ECH and VMess
TLS-mirror, require `tls: true`. VLESS flow is limited to empty or
`xtls-rprx-vision`; packet encoding is limited to `packetaddr`, `packet`, or
`xudp` and conflicts with the `packet-addr`/`xudp` aliases. TUIC relay and
congestion values, Shadowsocks plugins, and transport selectors use fixed
enums; Snell v1/v2 cannot enable UDP.

Node names stop at 512 characters. The validator rejects SSH filesystem key
references, limits OpenVPN to the fixed installed subset, validates Mieru enums
and its bounded strict traffic-pattern protobuf, and closes Sudoku enums,
ranges, and custom tables. MASQUE, TrustTunnel, TUIC, WireGuard, and Hysteria2
Realm fields have explicit dependency and resource checks. OpenVPN, WireGuard,
and MASQUE require `remote-dns-resolve: true` together with a non-empty `dns`
list whose entries use the conservative, fully consumed subset of fixed
Mihomo's nameserver grammar; whitespace, bad authorities, credentials,
query/fragment suffixes, and ignored paths reject. OpenVPN `udp` rejects because
the fixed constructor does not consume it. It also enforces fixed-constructor
required fields for Mieru, Sudoku, MASQUE, and OpenVPN,
accepts fixed-binary-verified H1/H2 `ports`-only endpoints, caps each port set at
28 segments, and caps aggregate expansion at 65,536 candidates. MASQUE EC keys
must be canonical Base64 DER with no trailing data; Hysteria fingerprints must
be exactly 32 bytes and are normalized to lowercase hex. Shadowsocks-2022 PSKs
require canonical Base64 and the exact method-specific decoded length;
multi-key EIH is AES-only. Duration scalars stop at 9,223,372,036 seconds;
AnyTLS `min-idle-session` and WireGuard `workers` stop at 256 to prevent target
overflow or allocation fanout. These source-backed schemas and selected
constructor invariants are not a claim that ProxyManager reimplements every
fixed-Mihomo constructor branch.

The frozen structured-validator checks passed 384/384 targeted Vitest cases,
targeted ESLint, and the full project typecheck. The targeted matrix covers all
24 portable proxy types, top-level and nested closed schemas, exact primitive
types, conditional credentials, enums, dependency conflicts, resource limits,
DNS grammars, and graph/name boundaries.

A deterministic matrix spot check used
`random.Random(20260715).sample(range(295), 20)`. Physical CSV lines 19, 38,
50, 63, 69, 77, 95, 105, 108, 113, 121, 125, 127, 143, 166, 170, 176, 213,
236, and 270 were checked against parser/helper code, named tests, and pinned
evidence. All 20 matched their protocol, location, accepted/rejected boundary,
Mihomo mapping, status, and direct-test marker.

## YAML merge differential

The fixed Mihomo binary was also run against this synthetic base skeleton:

```yaml
mixed-port: 7890
mode: rule
dns-defaults: &d
  nameserver-policy:
    "rule-set:ghost": [system]
dns:
  <<: *d
  enable: false
rules:
  - MATCH,DIRECT
```

`mihomo -t -f <fixture>` returned nonzero with `not found rule-set: ghost` and
configuration-test failure, proving that the target expands the inherited
policy before checking references. Replacing the semantic merge key with an
ordinary quoted `"<<"` key loaded successfully. The product regression therefore
rejects exactly the target's semantic merge forms before save or stored render,
not every scalar whose value happens to be `<<`.

## Independent red-team retest

The final review repeated trust-boundary probes without relying on the
implementation agents' summaries:

| Boundary                    | Independent result                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL and DNS pinning         | `[::ffff:7f00:1]`, hexadecimal/integer/octal-like IPv4, and shortened loopback forms rejected before network access. Pinned lookup returned only prevalidated addresses and rejected a hostname mismatch with `ENOTFOUND`.                                                                                                                                        |
| Chain wrapping              | A concrete backend that already carried `dialer-proxy` rejected instead of being overwritten by an implicit second hop.                                                                                                                                                                                                                                           |
| Collection provenance       | The enumerable source-provenance symbol survived filter, rename, dedup, sort, and spread paths; a targeted cross-source first-writer-wins test retained the node from the first subscription.                                                                                                                                                                     |
| regexp2 preview             | Fixed-target lookahead/backreference cases matched and JS/regexp2 Unicode mismatches rejected. The oracle covered 2,985 caseful code points, 9,018 regular plus 8,955 long-braced encodings, and 614 astral surrogate-pair controls with no bypass. Literals, ranges, properties, and `i`+`v` fail closed where required; uncased CJK/emoji and 512 bounds held.  |
| Contextual rule sets        | Three missing-provider, wrong-behavior, and valid-provider triads covered DNS policy, rule-mode fake-IP, and TUN address-set contexts; all 9/9 produced the expected reject/reject/accept outcome.                                                                                                                                                                |
| Provider activation         | A regex token and embedded sniffer prefix each activated a fake dormant URL before repair. The rule tree plus index-zero prefix now leaves both inert. A 20,496-form prefix/colon/comma oracle matched fixed source exactly; fixed-binary controls confirmed single-name versus comma splitting and that embedded substrings stay inert.                          |
| Conditional provider use    | Thirteen structured contexts covered both DNS policy maps, fake-IP dormant/case gates, four sniffer lists, root/listener TUN, and rules/sub-rules. Root TUN used its true omitted `auto-route` default; listener required both true. Exact types, `ipcidr`, aliases, no-op combinations, empty/missing names, and wrong behaviors all matched the fixed boundary. |
| YAML merge semantics        | Fixed v1.19.28 expanded merged DNS policy and rejected missing provider `ghost`, while the JavaScript AST exposed only `<<`. Seven block/flow/recursive/tag boundary probes matched go-yaml: plain, local-`!`, and explicit merges reject before save/render; quoted `"<<"` and explicit `!!str <<` remain literal keys.                                          |
| Dynamic group empty result  | A user `empty-fallback` was initially lost by template merge and a dynamic zero-match group therefore fell through to `COMPATIBLE`; the repaired path preserves explicit concrete fallbacks and otherwise renders `REJECT`.                                                                                                                                       |
| Include-all chain exclusion | Fixed Mihomo confirmed that `exclude-filter` is applied after the include-all pool is assembled. The final renderer preserves the user's backtick-separated programs and appends one anchored clone exclusion as a separate program.                                                                                                                              |
| Fixed rule decoding         | Go `netip` and the fixed binary reject left-half embedded IPv4 in compressed IPv6. Fixed `ParseRulePayload` trims each comma field in direct, nested logic, and `SUB-RULE` payloads; the product rejects every lossy raw form and analyses rule regexes with the constructor's forced `IgnoreCase`.                                                               |

## Final renderer and cache fail-closed probes

The repository suites exercise the stateful boundaries that a standalone
Mihomo `-t` fixture cannot model:

| Boundary          | Final asserted behavior                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy groups      | A non-empty managed group set without `# === PROXY-GROUPS ===` rejects. Dynamic groups default to explicit `empty-fallback: REJECT`; an explicit concrete fallback is preserved, while invalid or group-valued fallbacks reject.                                                                                                                                                                      |
| Rule providers    | Unresolved references reject across rules/sub-rules, both DNS policy maps, active fake-IP filters, sniffer domain/IP lists, and active root/listener TUN route sets with their distinct defaults. Domain/IP contexts are behavior-checked and TUN requires exactly `ipcidr`; active providers without the marker reject. Inactive features, comments, opaque scalars, and regex-like text stay inert. |
| Operators         | A subscription or collection operator exception rejects the source/render instead of substituting the unprocessed node list.                                                                                                                                                                                                                                                                          |
| Chain clones      | Multi-member wraps, wrap-name collisions, and invalid or cyclic cross-source `dialer-proxy` graphs reject. The complete base+subscription+clone list is revalidated; include-all groups append a separate anchored clone exclusion without replacing the user's regexp2 `exclude-filter`.                                                                                                             |
| Final references  | Group members/providers, proxy dialer targets, and rule policies must resolve; names cannot collide; group membership must be acyclic and retain a member source; removed `relay` rejects.                                                                                                                                                                                                            |
| Base YAML merges  | Untagged plain `<<`, local-`!` `<<`, and explicit `tag:yaml.org,2002:merge` keys reject before collectors or mutation; quoted `"<<"` and explicit `!!str <<` remain literal. This prevents target-only inherited fields from bypassing section, rule, provider-reference, or final-reference validation.                                                                                              |
| Resource limits   | URI input stops above 50,000 lines; every list above 50,000 nodes; H1/H2 ports above 28 segments/65,536 candidates; durations above 9,223,372,036 s; AnyTLS sessions, WG workers, and XHTTP session endpoints/cardinality above 256.                                                                                                                                                                  |
| Fetch cache       | Malformed envelopes and future timestamps miss; corrupt fresh/stale content is never used as fallback.                                                                                                                                                                                                                                                                                                |
| Render cache      | Empty/malformed envelopes, a mismatched SHA-256-derived build ID, far-future timestamps, or freshness above 24 hours miss.                                                                                                                                                                                                                                                                            |
| Global generation | A present-invalid `config:version` neither hits nor writes a legacy-v0 entry. Nonzero compare-and-set repair invalidates other profiles and cannot overwrite a concurrent valid increment.                                                                                                                                                                                                            |

All fixtures and tests use synthetic hosts and fake credentials. No production
subscription, cache entry, or configuration was read or changed.

## Cross-core VLESS configuration probes

The comparison probe is reproducible with
`web/scripts/proxy-compat/validate-core-comparison.ts`. Xray's own `vlessenc`
command generated one ephemeral X25519 and one ML-KEM-768 encryption pair in a
mode-`0600` temporary file. The script consumed only the public `encryption`
halves, never printed either half, and wrote all generated JSON only below the
temporary audit directory.

| Core                 | Case                                      | Fixed-binary result | Configuration conclusion                                         |
| -------------------- | ----------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| Xray-core `v26.3.27` | `encryption: "none"`                      | ACCEPT              | Explicit `none` is the no-encryption spelling in Xray JSON.      |
| Xray-core `v26.3.27` | omitted                                   | REJECT              | Omission is not equivalent to `none` in the fixed target.        |
| Xray-core `v26.3.27` | explicit empty string                     | REJECT              | Empty must not be normalized to `none`.                          |
| Xray-core `v26.3.27` | generated X25519 and ML-KEM forms         | ACCEPT (2/2)        | The long value is byte-sensitive and target-specific.            |
| v2ray-core `v5.51.2` | `encryption: "none"`                      | ACCEPT              | Current v2ray-core accepts its own explicit no-encryption value. |
| v2ray-core `v5.51.2` | omitted or empty                          | REJECT (2/2)        | It shares the explicit-`none` requirement.                       |
| v2ray-core `v5.51.2` | the two Xray-generated encrypted forms    | REJECT (2/2)        | Xray VLESS Encryption cannot be copied into v2ray-core JSON.     |
| sing-box `v1.13.14`  | minimal VLESS and `packet_encoding: xudp` | ACCEPT (2/2)        | sing-box uses its own structural fields.                         |
| sing-box `v1.13.14`  | Xray-style `encryption` field             | REJECT              | Xray's user field is not a sing-box outbound field.              |

Probe command (paths abbreviated here but recorded in the fixed-binary ledger):

```text
npx tsx scripts/proxy-compat/validate-core-comparison.ts \
  <xray> <sing-box> <v2ray> <xray-vlessenc-output> <temp-output-dir>
```

This is a configuration-construction comparison, not a live network handshake.
It demonstrates why the Mihomo YAML converter must not present one core's raw
field spelling as a portable semantic model.
