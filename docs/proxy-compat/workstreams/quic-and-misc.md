# QUIC and miscellaneous proxy URI compatibility audit

Audit date: 2026-07-15

> Historical research draft with an intermediate implementation snapshot.
> `../parameter-matrix.csv`, `../findings.md`, and `../validation.md` supersede
> every open/current-worktree/pre-lock statement below, including earlier
> Hysteria2 `keepalive`, `mport`, and structured-port descriptions.

This document began as a read-only protocol audit of Hysteria 1/2, Hysteria
Realm, TUIC, Snell, AnyTLS, WireGuard, SOCKS, and HTTP(S) proxy URIs. The
pre-implementation observations are retained below as historical evidence; the
current-worktree implementation status is recorded separately.

The implementation anchor is repository commit
`9596cec88fb17fd67ed7102b625b18bb92e9f68f`, observed with concurrent uncommitted
changes in `web/lib/proxies/uriToClash.ts` and
`web/tests/subscriptions/proxyUri.test.ts`. Function names are the durable
anchors; current-worktree line numbers are recorded only as a convenience.

All dynamic parser probes used generated `.example.test` hosts and credentials
such as `fake-auth`, `fake-token`, and all-zero fake WireGuard keys. No real
subscription, node, password, token, cookie, or key was read or printed.

## Implementation status

Implemented and test-first verified in the current worktree on 2026-07-15:

| Family     | Implemented boundary                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hysteria 1 | Requires nonzero speeds accepted by the pinned target grammar, retaining evidenced `up`/`down` aliases; validates `udp`/`wechat-video`/`faketcp`; maps official `obfsParam` to Mihomo `obfs` and never treats `obfs=xplus` as the password.                                                                         |
| Hysteria 2 | Maps official `ech` to `ech-opts: {enable: true, config: ...}`; accepts only `salamander`/`gecko` with a password or `none` without one; validates port sets/ranges and rejects semicolon syntax. Realm schemes remain explicitly unsupported and are not registered as ordinary H2.                                |
| TUIC       | The URI dialect is intentionally v5-only: canonical lowercase UUID plus non-empty password. Token-only/v4 forms fail closed. Existing mapped congestion, UDP relay, and boolean values are validated before emission.                                                                                               |
| WireGuard  | The URI dialect is a single-peer full-tunnel shortcut. It requires canonical standard-Base64 32-byte private/public keys and at least one valid local prefix, preserves CIDR in `ip`/`ipv6`, validates reserved bytes and typed scalars, and rejects `allowed-ips`, `peers`, `dns`, duplicates, and unknown addons. |
| Snell      | Materializes target default v1, accepts only integer versions 1-5, and limits the URI obfs shape to representable `http`/`tls` modes. Incomplete ShadowTLS and mismatched obfs host/mode fail closed.                                                                                                               |
| SOCKS      | Username-only Base64 shorthand remains supported, but any explicit URL password separator disables that guess, including an explicitly empty password.                                                                                                                                                              |
| HTTP(S)    | Raw authority is retained long enough to recognize explicit default ports 80/443. The proxy URI convention now requires an explicit port and rejects every path or query, including `/`, to reduce ordinary-origin/subscription URL ambiguity.                                                                      |
| AnyTLS     | Official stable `sni`/`insecure` plus named Mihomo extensions use a bounded allowlist. Boolean values are exact `0`/`1`, timing values are non-negative integer scalars, duplicates and unknown addons fail closed, and wildcard passthrough is removed.                                                            |

The three focused regression batches recorded the old implementation before
each fix: H1/H2 `17` failures -> `23` passing cases; TUIC/WireGuard `22` ->
`28`; Snell/SOCKS/HTTP(S)/AnyTLS `25` -> `37`. The resulting targeted parser
file has `255/255` passing tests before the broader integration run.

In the current pre-lock verification, the complete subscription suite passes
`409/409` tests across nine files, and the full web suite passes `813/813`
tests across 48 files. The locked-dependency final gate is recorded separately
in `validation.md`.

### Bounded query policies

- AnyTLS canonicalizes `_` to `-` and allows only `sni`, `peer`, `alpn`,
  `insecure`, `fp`, `udp`, `tfo`, `mptcp`, `idle-session-check-interval`,
  `idle-session-timeout`, and `min-idle-session`. Duplicate canonical keys and
  every other query key are rejected.
- WireGuard lowercases names, canonicalizes `_` to `-`, and aliases
  `publickey`/`privatekey` to `public-key`/`private-key`. Its complete allowlist
  is `public-key`, `private-key`, `address`, `ip`, `reserved`, `mtu`, `udp`,
  `pre-shared-key`, `persistent-keepalive`, `workers`, and
  `refresh-server-ip-interval`. It explicitly rejects `allowed-ips`, `peers`,
  `dns`, and `remote-dns-resolve`; the latter cannot satisfy the fixed target's
  mandatory structured `dns[]` pairing in this flat URI dialect. Duplicate
  canonical keys and every unknown key are also rejected.
- TUIC retains its existing mapped query surface (`sni`, `alpn`,
  `congestion_control`, `udp_relay_mode`, `allow_insecure`, `insecure`, and
  `disable_sni`) but now validates the mapped enums and exact `0`/`1` booleans.

## Evidence boundary

The committed output target is Mihomo `v1.19.28`, commit
[`cbd11db1e13a75d8e680e0fe7742c95be4cba2be`](https://github.com/MetaCubeX/mihomo/commit/cbd11db1e13a75d8e680e0fe7742c95be4cba2be).
Xray-core `v26.3.27` and sing-box `v1.13.14` are comparison targets, not output
contracts. Sub-Store `2.36.7` is an ecosystem differential oracle only.

| Level     | Evidence used here                                                    | Boundary                                                                               |
| --------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `E1`      | Protocol-project URI/specification or an IETF/WireGuard specification | Controls URI or protocol meaning when one exists                                       |
| `E2`      | Mihomo documentation at a fixed commit                                | Documents intended target fields, but fixed source wins on a release-specific conflict |
| `E3`      | Mihomo, Xray-core, and sing-box source at fixed release commits       | Proves exact fields, types, defaults, and construction errors                          |
| `E4-lite` | In-memory `tsx` calls to `parseProxyUriList` with fake values         | Reproduces ProxyManager output only; no protocol traffic was sent                      |
| `E5`      | Sub-Store `2.36.7` fixed source                                       | Interoperability hint, never promoted to a standard                                    |

The audit phase did not execute an official core binary. The implementation
pass additionally ran the parser's representative H1, H2, TUIC, Snell, AnyTLS,
WireGuard, SOCKS, HTTP, and HTTPS output through `mihomo -t -f /dev/stdin` using
Mihomo `v1.19.28` darwin-arm64 SHA-256
`55b7286331cb30a54b2564013b02b84a0c280e8b690bd1e5da4b9d4f4ca007ac`;
the combined configuration test succeeded.

## Source index

### Protocol and URI sources

- Hysteria 1: the live [official URI page](https://v1.hysteria.network/docs/uri-scheme/)
  retrieved 2026-07-15 and the Hysteria repository README at
  [`f2ad1de5da52a1da9622285a1d61553ddaa41f21`](https://github.com/apernet/hysteria/blob/f2ad1de5da52a1da9622285a1d61553ddaa41f21/README.md).
  The README labels 1.x **legacy**; it does not make a Hysteria 1 URI a
  Hysteria 2 URI.
- Hysteria 2 and Realm: the live [official URI page](https://v2.hysteria.network/docs/developers/URI-Scheme/)
  retrieved 2026-07-15. It defines `hysteria2`, `hy2`,
  `hysteria2+realm`, and `hysteria2+realm+http`.
- TUIC: official protocol repository at
  [`8e118f242f24a17a9f487dc344cc50d7e63e557e`](https://github.com/tuic-protocol/tuic/tree/8e118f242f24a17a9f487dc344cc50d7e63e557e),
  including [`SPEC.md`](https://github.com/tuic-protocol/tuic/blob/8e118f242f24a17a9f487dc344cc50d7e63e557e/SPEC.md).
  TUIC v4 behaviour is also visible in the official `0.8.5` README at
  [`0303155b28a24cd0fa2e9efa8832dd914fe74a5a`](https://github.com/tuic-protocol/tuic/blob/0303155b28a24cd0fa2e9efa8832dd914fe74a5a/README.md).
  No official `tuic://` sharing specification was found in the official tree.
- Snell: the live [Surge Snell release page](https://kb.nssurge.com/surge-knowledge-base/release-notes/snell)
  retrieved 2026-07-15. No official `snell://` URI specification was found.
- AnyTLS: stable `v0.0.13` URI document at
  [`9666872946857b50a74fdb692896d77b53773cb2`](https://github.com/anytls/anytls-go/blob/9666872946857b50a74fdb692896d77b53773cb2/docs/uri_scheme.md).
  The default branch at
  [`0c36ca9f0d88bc1af5ddb998e619166913c7445c`](https://github.com/anytls/anytls-go/blob/0c36ca9f0d88bc1af5ddb998e619166913c7445c/docs/uri_scheme.md)
  additionally documents the fragment as a percent-encoded display name; that
  fragment text post-dates the pinned stable document.
- WireGuard: official `wg(8)` configuration grammar at
  [`wireguard-tools a998407747005ea7e4e0258d96f105c97241e1d3`](https://git.zx2c4.com/wireguard-tools/tree/src/man/wg.8?id=a998407747005ea7e4e0258d96f105c97241e1d3).
  It defines one `[Interface]`, repeated `[Peer]` sections, and peer-scoped,
  repeatable `AllowedIPs`; it does not define `wireguard://` or `wg://`.
- HTTP and SOCKS: [RFC 9110 sections 4.2.1-4.2.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-4.2),
  [RFC 1928](https://www.rfc-editor.org/rfc/rfc1928),
  [RFC 1929](https://www.rfc-editor.org/rfc/rfc1929), and the
  [IANA URI Schemes registry](https://www.iana.org/assignments/uri-schemes/uri-schemes.xhtml).
  IANA registers `http` and `https`; it does not register `socks` or `socks5`.

### Target and differential sources

- Mihomo option and constructor sources:
  [`hysteria.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/hysteria.go),
  [`hysteria2.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/hysteria2.go),
  [`ech.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/ech.go),
  [`tuic.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/tuic.go),
  [`snell.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/snell.go),
  [`anytls.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/anytls.go),
  [`wireguard.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/wireguard.go),
  [`socks5.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/socks5.go), and
  [`http.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/http.go).
- Mihomo fixed documentation:
  [`hysteria.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/hysteria.en.md),
  [`tuic.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/tuic.en.md),
  [`anytls.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/anytls.en.md),
  [`wg.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/wg.en.md),
  [`socks.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/socks.en.md), and
  [`http.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/http.en.md).
  Current Hysteria 2 and Snell docs are newer than that fixed docs snapshot;
  release source is used for exact target behaviour.
- Mihomo decoder:
  [`common/structure/structure.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/common/structure/structure.go).
  Numeric strings weakly coerce to integers, but a string does **not** coerce to
  a slice, and unknown map keys are silently ignored.
- Xray-core comparison:
  [`proxy/`](https://github.com/XTLS/Xray-core/tree/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/proxy),
  [`infra/conf/hysteria.go`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/infra/conf/hysteria.go), and
  [`infra/conf/wireguard.go`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/infra/conf/wireguard.go).
- sing-box comparison at
  [`25a600db24f7680ad9806ce5427bd0ab8afe1114`](https://github.com/SagerNet/sing-box/commit/25a600db24f7680ad9806ce5427bd0ab8afe1114):
  [`option/hysteria.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/hysteria.go),
  [`option/hysteria2.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/hysteria2.go),
  [`option/tuic.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/tuic.go),
  [`option/anytls.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/anytls.go),
  [`option/wireguard.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/wireguard.go), and
  [`option/simple.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/simple.go).
- Sub-Store differential parser at
  [`0882a5222913aa48d6509ef471a0185d7e07f3d9`](https://github.com/sub-store-org/Sub-Store/blob/0882a5222913aa48d6509ef471a0185d7e07f3d9/backend/src/core/proxy-utils/parsers/index.js#L2096-L2484).

## Audit findings (historical pre-implementation state)

The result column below describes the frozen parser state at audit time. Use
the implementation-status section above for the current-worktree result.

| ID       | Priority       | Confidence           | Result                                                                                                                                                                                                                                        |
| -------- | -------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QM-001` | P1             | High                 | Hysteria 1 maps official `obfs=xplus` into Mihomo's **password** field and drops official `obfsParam`; the emitted node uses `xplus` as the password.                                                                                         |
| `QM-002` | P1             | High                 | Hysteria 1 accepts a URI without required `upmbps`/`downmbps`; Mihomo later fails upload/download speed construction.                                                                                                                         |
| `QM-003` | P1             | High                 | Hysteria 2 silently drops official `ech`; the target supports the required structural `ech-opts` mapping.                                                                                                                                     |
| `QM-004` | P1 gap         | High                 | Official Realm schemes are unregistered. A correct implementation must preserve repeated `stun`; `lport` has no field in pinned Mihomo and must be diagnosed rather than silently dropped.                                                    |
| `QM-005` | P1             | High target mismatch | The TUIC parser always emits v5 `uuid/password`; a v4 token-form link becomes an invalid v5 identity instead of Mihomo `token`. TUIC has no official URI, so this is an ecosystem-dialect defect, not a protocol-URI violation.               |
| `QM-006` | P1             | High                 | WireGuard URI output is accepted without local address or peer public key, although pinned Mihomo requires them during construction.                                                                                                          |
| `QM-007` | P1             | High                 | WireGuard `allowed-ips` is emitted as a scalar and repeated occurrences collapse last-wins; Mihomo expects a slice. Even a valid top-level array is ignored by the pinned flat constructor, so constrained routes require structural `peers`. |
| `QM-008` | P2             | High                 | A literal SOCKS username that happens to decode as Base64 `user:pass` overrides an explicit URL password.                                                                                                                                     |
| `QM-009` | P2             | High                 | `https://host:443` and `http://host:80` are rejected despite explicit ports because WHATWG `URL` normalizes default ports to an empty `.port`.                                                                                                |
| `QM-010` | P2 design risk | High                 | Root-path HTTP(S) URLs with a non-default explicit port and arbitrary query are accepted as proxies, while their query is silently discarded; the scheme alone cannot distinguish an origin/subscription URL from a proxy convention.         |
| `QM-011` | P2             | High                 | `snell://...?version=bogus` emits JavaScript `NaN` (JSON displays it as `null`) instead of rejecting it.                                                                                                                                      |
| `QM-012` | P2             | High                 | AnyTLS and WireGuard arbitrary-addon passthrough creates false support: unknown keys survive provider YAML but pinned Mihomo silently ignores them; slice fields such as `dns`/`allowed-ips` instead fail decoding when emitted as strings.   |
| `QM-013` | P2             | High                 | Hysteria 2 accepts semicolon-separated port sets and emits the semicolon unchanged, but pinned Mihomo's range parser accepts comma or slash separators, not semicolon, so construction fails.                                                 |

## Protocol ledger

### Hysteria 1

| Contract item             | Audited result                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URI structure and aliases | Official: `hysteria://host:port?...#remarks`; host, port, `upmbps`, and `downmbps` are required. Official source does not define `hy://`. Sub-Store accepts `hysteria`/`hy`; ProxyManager registers only `hysteria`, which is standards-correct but not full Sub-Store dialect parity.                                                        |
| Raw keys                  | Official: `protocol`, `auth`, `peer`, `insecure`, `upmbps`, `downmbps`, `alpn`, `obfs`, `obfsParam`. Current aliases/extensions: `auth_str`, `sni`, `up`, `down`. Query names are case-sensitive in practice; `obfsParam` must retain its capital `P`.                                                                                        |
| Types and defaults        | `protocol` string defaults to `udp` and permits `udp`, `wechat-video`, `faketcp`; `insecure=1` is true; bandwidth values are strings accepted by Mihomo's speed parser; `alpn` becomes a string list. H1 URI `obfs` is a mode (`xplus`), while `obfsParam` is the password.                                                                   |
| Decode and repeats        | WHATWG `URLSearchParams` percent-decodes user input. `paramsToRecord` is last-wins, so duplicates are not preserved. The official H1 URI defines no repeatable key.                                                                                                                                                                           |
| Mihomo mapping            | `auth` -> `auth-str`; `peer` -> `sni`; `upmbps` -> `up`; `downmbps` -> `down`; `obfsParam` -> Mihomo `obfs`; `insecure=1` -> `skip-cert-verify: true`. The URI mode `obfs=xplus` has no separate Mihomo field and must not overwrite the password. Mihomo requires nonzero parseable `up` and `down`; omitted `protocol` defaults internally. |
| Current implementation    | `parseHysteria` at current-worktree lines 817-841 maps `obfs` directly and never reads `obfsParam`. It conditionally writes speeds but does not require them. It correctly handles host/port, `auth`/`auth_str`, `peer`/`sni`, ALPN, and `insecure=1`.                                                                                        |
| Xray/sing-box difference  | Xray stable has no H1 client: its `hysteria` config explicitly requires `version == 2`. sing-box stable still has an H1 outbound with `server_ports`, `hop_interval`, bandwidth, auth, obfs password, and TLS; it does not expose Mihomo's H1 `protocol` selector.                                                                            |
| Existing tests and gaps   | No direct positive H1 fixture exists. Add official `obfs`+`obfsParam`, missing up/down rejection, three protocol values, percent-encoded auth/fragment, `hy://` policy, malformed speeds, and aliases as separate tests.                                                                                                                      |

#### Hysteria 1 legacy boundary

Hysteria upstream labels 1.x **legacy**, but pinned Mihomo still constructs the
protocol and sing-box stable still exposes it. The safe boundary is:

1. keep H1 and H2 as different parser families;
2. do not rewrite `hysteria://` to `hysteria2://`;
3. do not reject H1 solely because upstream calls it legacy while the committed
   target still supports it;
4. surface a compatibility/deprecation notice separately from parse validity;
5. validate H1's own required bandwidth values and obfuscation semantics.

### Hysteria 2

| Contract item             | Audited result                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URI structure and aliases | Official: `hysteria2://[auth@]hostname[:port]/?...`; aliases are exactly `hysteria2` and `hy2`. Port defaults to 443 and the authority port supports Hysteria multi-port syntax.                                                                                                                                                                                                                                                                                |
| Raw keys                  | Official: `obfs`, `obfs-password`, `sni`, `insecure`, `pinSHA256`, `ech`. Current extensions/aliases: `peer`, `alpn`, `fastopen`, `mport`, `hop-interval`, `hop_interval`, `keepalive`, `upmbps`, `downmbps`.                                                                                                                                                                                                                                                   |
| Types and defaults        | Auth is an opaque percent-encoded string; the `username:password` special case remains one auth value. Official `insecure` is `1`/`0`. `obfs` currently permits `salamander`/`gecko` and needs `obfs-password`. `ech` is a Base64 ECHConfigList. Client bandwidth and local client modes must never be placed in an official share URI.                                                                                                                         |
| Decode and repeats        | The hand parser percent-decodes auth, query values, and fragment, splits on the last raw `@`, and accepts unescaped `@` as an extension. Query duplicates are last-wins. Ordinary H2 defines no repeatable query key. It accepts comma or semicolon port separators, but pinned Mihomo's range parser accepts comma/slash, not semicolon; the semicolon path is invalid output rather than working compatibility.                                               |
| Mihomo mapping            | Auth -> `password`; multi-port -> `ports`; `pinSHA256` -> certificate `fingerprint`; `ech` -> `ech-opts: {enable: true, config: <base64>}`; gecko uses `obfs: gecko`, `obfs-password`, with optional target-only `obfs-min-packet-size`/`obfs-max-packet-size`. The size keys are Mihomo extensions, not official URI fields.                                                                                                                                   |
| Current implementation    | `parseHysteria2` at lines 843-920 correctly handles optional auth, IPv4/IPv6, comma-separated port sets/ranges, default 443, SNI, pin, salamander/gecko names, ALPN, and several extensions. It drops official `ech`. It accepts `insecure=true` beyond the official `1`, maps officially forbidden per-user `upmbps/downmbps`, and accepts target-invalid semicolon port sets.                                                                                 |
| Xray/sing-box difference  | Xray stable has a version-2 Hysteria outbound/transport model rather than Mihomo field parity; it has no H1 and no Realm URI mapping. sing-box stable H2 supports only `salamander` in its constructor, not pinned Mihomo's `gecko`; its generic TLS layer can carry TLS options, and it has no Realm option.                                                                                                                                                   |
| Existing tests and gaps   | Existing tests cover `hy2`, salamander, SNI, insecure, comma port hopping, `mport`, `peer`, `obfs=none`, hop interval, keepalive, bandwidth extensions, pin, optional auth, raw `@`, and IPv6. Missing: official `ech`, gecko success plus missing-password failure, userpass auth, exact `0` handling, encoded delimiters, semicolon rejection/normalization, duplicate-policy tests, and explicit classification of nonstandard bandwidth/alpn/fastopen keys. |

### Hysteria 2 Realm

| Contract item             | Audited result                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URI structure and aliases | Official HTTPS rendezvous: `hysteria2+realm://token@rendezvous-host[:port]/realm-name?...`; HTTP rendezvous: `hysteria2+realm+http://...`. Userinfo is the **rendezvous token**, host is the rendezvous server, and path is the realm ID. Port hopping in the authority is not supported.                              |
| Raw keys                  | All ordinary H2 keys plus `auth`, repeated `stun`, and `lport`. Here `auth` is the Hysteria credential because userinfo is occupied by the rendezvous token.                                                                                                                                                           |
| Types/defaults/repeats    | `stun` is explicitly repeatable and order-preserving. `lport` is integer 1-65535 and defaults to an ephemeral local UDP port. Realm path must be non-empty. Scheme selects HTTPS versus HTTP for rendezvous.                                                                                                           |
| Mihomo mapping            | Top level remains `type: hysteria2`, `password: <auth>`, H2 obfs/TLS/ECH fields. Realm maps to `realm-opts.enable`, `server-url`, `token`, `realm-id`, and `stun-servers: string[]`. Pinned Mihomo has **no `lport` field**; an importer must report it as unsupported for this target rather than claim preservation. |
| Current implementation    | Neither Realm scheme is in `PARSERS`; both produce an explicit unsupported-scheme error. The shared query helpers could not implement Realm correctly without change because they collapse repeated `stun`.                                                                                                            |
| Xray/sing-box difference  | Neither pinned Xray nor pinned sing-box exposes Mihomo's Realm option structure. This feature is target-specific in the compared stable releases.                                                                                                                                                                      |
| Existing tests and gaps   | No Realm test exists. Add both schemes, default/explicit rendezvous port, token/auth separation, required realm path, repeated STUN preservation, `lport` unsupported-target diagnostic, H2 ECH mapping, and a no-port-hopping rejection.                                                                              |

### TUIC v4 and v5

| Contract item             | Audited result                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URI structure and aliases | `tuic://` is an ecosystem convention; no official sharing URI was found. The common v5 authority shape is `tuic://uuid:password@host:port?...`. A v4 token-only authority is used by some clients, but without a versioned URI standard the accepted dialect must be documented explicitly.                                                                  |
| Raw keys                  | Current parser names `sni`, `alpn`, `congestion_control`, `udp_relay_mode`, `allow_insecure`, `insecure`, `disable_sni`. Sub-Store additionally normalizes hyphenated forms and handles `fast-open`, `reduce-rtt`, `congestion-control`; those are E5 dialect evidence only.                                                                                 |
| Types and defaults        | Mihomo selects v4 iff `token` is non-empty; otherwise it selects v5 `uuid/password`. Target defaults include ALPN `h3`, request timeout 8000 ms, heartbeat 10000 ms, UDP relay `native` unless exactly `quic`, max datagram-derived sizes, and Fast Open false. URI port has no official default; Sub-Store uses 443 while current ProxyManager requires it. |
| Decode and repeats        | WHATWG URL percent-decodes username/password. Current query conversion is last-wins and booleans accept only `1`; ALPN is split into a list. No official repeated TUIC URI key is established.                                                                                                                                                               |
| Mihomo mapping            | v4 -> `token` only; v5 -> `uuid` and `password` only. Shared target fields include `sni`, `alpn`, `congestion-controller`, `udp-relay-mode`, `disable-sni`, `reduce-rtt`, `request-timeout`, `heartbeat-interval`, `fast-open`, ECH/TLS, and UDP-over-stream fields. Never emit token and UUID/password together.                                            |
| Current implementation    | `parseTUIC` at lines 922-948 always reads username as UUID and password as v5 password. `tuic://fake-v4-token@tuic.example.test:443` becomes `{uuid: "fake-v4-token", password: ""}` and therefore selects Mihomo v5. It maps only a narrow underscore-key subset and does not validate UUID shape, congestion value, or relay mode.                         |
| Xray/sing-box difference  | Xray stable has no TUIC outbound. sing-box stable supports only TUIC v5 UUID/password; it has no v4 token field. Therefore a v4 node cannot be losslessly translated to sing-box.                                                                                                                                                                            |
| Existing tests and gaps   | One v5-shaped fixture exists, but its `uuid-xx` is not a valid UUID. Add a valid v5 UUID, a documented v4 token dialect or explicit unsupported result, mutual exclusion, missing v5 password, default/explicit port policy, hyphen/underscore aliases, boolean false, enum rejection, timeout/heartbeat typing, ECH, and v4-to-sing-box loss tests.         |

### Snell

| Contract item             | Audited result                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URI structure and aliases | `snell://psk@host:port?...#name` is an ecosystem format. Surge documents the protocol/server but no official sharing URI was found. There is no alias in the current registry.                                                                                                        |
| Raw keys                  | Current URI parser accepts `version`, `obfs`, `obfs-host`. Mihomo additionally supports `udp`, `reuse`, `client-fingerprint`, and richer `obfs-opts`, including ShadowTLS password/version/ALPN. Those target fields do not imply URI spellings.                                      |
| Types and defaults        | Pinned Mihomo default is Snell v1. Supported inputs are v1/v2, v3/v4, and v5; v5 is internally used as v4 because the v5 server is backward-compatible. UDP is unavailable on v1/v2 and supported on v3/v4/v5. `reuse` is relevant to v4/v5.                                          |
| Decode and repeats        | PSK and fragment are percent-decoded through URL. Query is last-wins. `version` must be an integer from the target-supported set; no repeated key is specified.                                                                                                                       |
| Mihomo mapping            | userinfo -> `psk`; `version` -> integer; `obfs`/`obfs-host` -> `obfs-opts.mode`/`host`. Target accepts empty/http/tls/shadow-tls modes; ShadowTLS requires nested fields which current URI parsing cannot express.                                                                    |
| Current implementation    | `parseSnell` at lines 950-972 correctly maps the basic shape and v4 fixture, but uses unchecked `parseInt`. `version=bogus` leaves `version: NaN` in the object; JSON rendering shows `null`. Unknown obfs modes are forwarded to fail only in Mihomo. URI `udp`/`reuse` are ignored. |
| Xray/sing-box difference  | Neither pinned Xray nor pinned sing-box exposes a Snell outbound. Snell nodes are not portable to those targets.                                                                                                                                                                      |
| Existing tests and gaps   | Existing coverage is one v4 + HTTP obfs happy path. Add omitted version -> target v1, v1-v5, invalid/float/out-of-range versions, UDP/version compatibility, reuse, TLS and ShadowTLS shapes, missing PSK/port, percent encoding, and unsupported-target tests.                       |

### AnyTLS

| Contract item             | Audited result                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URI structure and aliases | Official stable document: `anytls://[auth@]hostname[:port]/?...`; only `anytls`. Port defaults to 443. Stable `v0.0.13` does not mention a fragment; current main documents `#display-name`, which ProxyManager already supports.                                                                                                                                                    |
| Raw keys                  | Official stable keys are only `sni` and `insecure`. Current extensions are `peer`, `alpn`, `fp`, `udp`, all timing keys, common options, and arbitrary `_` -> `-` passthrough. The official document explicitly warns that third parties must not assume extensions are understood elsewhere.                                                                                        |
| Types and defaults        | Official `insecure` is exactly `1`/`0`. Mihomo target timing fields are integer seconds with effective defaults 30/30/0; target `udp` is a bool. Current parser defaults `udp: true` as a product choice, accepts `insecure=true`, and leaves timing values as strings. Numeric strings happen to weak-coerce in pinned Mihomo.                                                      |
| Decode and repeats        | WHATWG URL percent-decodes auth, query, and fragment. `paramsToRecord` is last-wins. Official AnyTLS URI defines no repeated key. Empty auth is rejected by current target-oriented parser.                                                                                                                                                                                          |
| Mihomo mapping            | auth -> `password`; host/port; `sni`; `insecure=1` -> `skip-cert-verify`. ALPN, client fingerprint, UDP, ECH, and timings are valid Mihomo YAML fields but are nonstandard URI extensions and require an explicit dialect. Unknown keys have no target meaning.                                                                                                                      |
| Current implementation    | `parseAnyTLS` at lines 1027-1060 handles official structure/default/SNI/insecure and current-main fragment. It also passes every other non-empty key through. Pinned Mihomo ignores unknown keys, so `unknown_key=fake` appears in generated YAML as `unknown-key: fake` but has no runtime effect. Slice/object extensions cannot be represented safely by the generic scalar path. |
| Xray/sing-box difference  | Xray stable has no AnyTLS outbound. sing-box stable supports AnyTLS password, generic TLS, and duration-typed idle-session fields; it does not use Mihomo's `udp` enable flag and expresses durations rather than bare integer-second YAML fields.                                                                                                                                   |
| Existing tests and gaps   | Existing tests cover basic extended form, default port, `udp=0`, `peer`, and boolean passthrough. Missing: official-only minimal fixture, exact `insecure=0/1` versus extension policy, special-character auth/name, unknown-key warning/rejection, numeric timing validation and canonical types, duplicate keys, ECH-extension policy, and target-differential duration handling.  |

### WireGuard

| Contract item             | Audited result                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URI structure and aliases | WireGuard officially defines an INI-like config, not a URI. ProxyManager/Sub-Store use ecosystem `wireguard://privateKey@server[:port]?...` and `wg://...`, defaulting port to 51820. Both registered aliases are nonstandard.                                                                                                                                                                                                                                   |
| Raw keys                  | Special handling: `publickey`/`public-key`, `privatekey`/`private-key`, `address`/`ip`, `reserved`, `mtu`, `udp`. Generic passthrough can spell `pre-shared-key`, `persistent-keepalive`, `remote-dns-resolve`, `dns`, `allowed-ips`, `workers`, etc., but a spelling being passed through does not mean its type or semantics are supported.                                                                                                                    |
| Types and defaults        | Official keys are Base64 keys; `AllowedIPs` is a peer-scoped comma list and may be repeated; `PersistentKeepalive` is 0/off or 1-65535 seconds. Pinned Mihomo requires at least one local `ip`/`ipv6`, a Base64 private key, and a peer public key. Target MTU defaults to 1408. Current URI defaults `udp: true` and port 51820.                                                                                                                                |
| Decode and repeats        | Authority private key and all query values are percent-decoded. `address` splits comma values but keeps at most one IPv4 and one IPv6. `reserved` accepts exactly three successfully parsed integers, otherwise it is silently omitted. `paramsToRecord` collapses every repeated query last-wins. Generic `allowed-ips`/`dns` remain scalar strings, but Mihomo requires slices.                                                                                |
| Mihomo flat mapping       | For one peer, top-level `server`, `port`, `public-key`, `pre-shared-key`, and `reserved` are the flat peer. Pinned source requires local prefixes and decodes both keys. Crucially, although fixed docs show flat top-level `allowed-ips`, pinned constructor does not consume it in the flat branch; it generates `/0` per local address family. This is a fixed docs/source conflict.                                                                          |
| Mihomo full mapping       | `peers` is an array of `{server,port,public-key,pre-shared-key,reserved,allowed-ips}`. When non-empty, peer fields replace/ignore the flat top-level peer, and **every peer requires a non-empty `allowed-ips` array**. Full form is the only pinned-source path that preserves constrained or multiple peer routes.                                                                                                                                             |
| Current implementation    | `parseWireGuard` at lines 1062-1121 always emits flat form. It requires only private key and host, not local address or public key. `allowed-ips=...` becomes a string; duplicates retain only the last. `peers=...` cannot become a structural array. Unknown `label=edge` is retained even though Mihomo ignores it.                                                                                                                                           |
| Xray/sing-box difference  | Xray uses `address: string[]` plus structural `peers`, defaults missing peer `allowedIPs` to both `/0`, and defaults MTU 1420. sing-box v1.13.14 models WireGuard as an endpoint with required `address[]`, `private_key`, and peer array. Neither has Mihomo's flat one-peer shortcut.                                                                                                                                                                          |
| Existing tests and gaps   | Existing tests cover both aliases, default 51820, one v4 + one v6 address, reserved, MTU, public-key aliases, and typed passthrough. Missing: required local address/public key, key length/Base64, invalid reserved hard failure, multiple same-family addresses, repeat-preserving AllowedIPs, scalar-vs-list decoder failure, flat-source `/0` behaviour, structural peers, peer-required AllowedIPs, PSK, DNS list, and Xray/sing-box structural conversion. |

#### WireGuard `allowed-ips` decision

Do not “fix” `allowed-ips` by merely splitting the current scalar and leaving it
top-level. At the pinned Mihomo release that would pass structural decoding but
the flat constructor still ignores it and installs `/0` routes based on local
address families. The lossless choices are:

1. build `peers: [{... allowed-ips: [...] }]` for URI dialects that promise
   constrained routes; or
2. explicitly document the flat dialect as one full-tunnel peer and reject an
   `allowed-ips` query that cannot be honoured.

### SOCKS

| Contract item             | Audited result                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URI structure and aliases | SOCKS5 protocol is standardized by RFC 1928, but `socks://`/`socks5://` sharing URIs are not IANA-registered. ProxyManager accepts both as ecosystem aliases and requires a port. It does not accept `socks4`, `socks4a`, `socks5h`, or Sub-Store's `socks5+tls`.              |
| Raw keys                  | No query key is read. Structural carriers are URL username, URL password, host, port, and fragment. A username-only Base64 `user:pass` shorthand is also guessed.                                                                                                              |
| Types and defaults        | Output is always Mihomo `type: socks5` and always `udp: true`. RFC 1928 defines `UDP ASSOCIATE`, but an endpoint can refuse it; the URI convention has no standardized UDP default. Username/password are separate 1-255 byte fields in RFC 1929, not a Base64 URI field.      |
| Decode and repeats        | URL userinfo is percent-decoded. Before respecting normal user/password, current code tries to Base64-decode **username alone** and switches semantics if decoded text contains `:`. Query and repeats are ignored.                                                            |
| Mihomo mapping            | URL user/password -> `username`/`password`; target also supports optional TLS, certificate-verification/pinning fields, and a boolean `udp`. It has no SOCKS-specific SNI field. No URI standard defines how those target extensions should be encoded.                        |
| Current implementation    | `parseSocks` at lines 974-1002 works for plain credentials and Base64 shorthand. It is ambiguous when an explicit password is present: `socks5://dXNlcjpwYXNz:literal-pass@socks.example.test:1080` emits `user/pass`, discarding the literal username and explicit password.  |
| Xray/sing-box difference  | Xray's outbound client is SOCKS5-only and supports UDP. sing-box supports versions `4`, `4a`, and `5`, defaults to `5`, enables both networks by default, and has an explicit UDP-over-TCP option.                                                                             |
| Existing tests and gaps   | One plain user/password test exists. Add anonymous, username-only, Base64 shorthand, Base64-looking literal username with explicit password, percent-encoded colon/@, malformed Base64, UDP policy, TLS dialect policy, unsupported version schemes, and IANA ambiguity tests. |

### HTTP and HTTPS proxy URIs

| Contract item             | Audited result                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URI structure and aliases | RFC 9110 defines `http://authority/path?query` and `https://...` as **origin identifiers**, not proxy share links. Using the same schemes for proxy endpoints is a configuration convention. RFC 9110 deprecates `user:password` userinfo and warns about untrusted userinfo. ProxyManager maps both schemes to Mihomo `type: http`, with `https` setting `tls: true`. |
| Raw keys                  | No query key is read. Structural carriers are userinfo, host, explicit port, root/empty path, and fragment. Current code rejects non-root paths.                                                                                                                                                                                                                       |
| Types and defaults        | Current policy requires an explicit port to reduce origin/subscription confusion. RFC normalization removes a port equal to the scheme default; WHATWG `URL.port` therefore becomes empty for explicit `http:80` and `https:443`. Query strings are permitted by URL parsing but ignored by proxy mapping.                                                             |
| Decode and repeats        | Userinfo and fragment are percent-decoded. Query values and repeats are silently discarded. A root path `/` and empty path normalize equivalently in RFC 9110.                                                                                                                                                                                                         |
| Mihomo mapping            | user/password -> `username`/`password`; `https` -> `tls: true`. Target also supports `sni`, certificate verification/fingerprint/cert/private-key, and headers, but the current URI dialect has no declared query mapping for them. Mihomo HTTP has no path field, so rejecting a non-root path is target-consistent.                                                  |
| Current implementation    | `parseHttp` at lines 1131-1152 rejects non-root paths and tests `u.port`. Consequently an explicitly written `https://proxy.example.test:443` is rejected. Conversely `https://sub.example.test:8443/?token=fake` is accepted as a proxy and its query is dropped.                                                                                                     |
| Xray/sing-box difference  | Xray supports HTTP client credentials/headers and applies TLS through stream settings. sing-box HTTP supports credentials, request `path`, headers, and a structural TLS object; its HTTP path has no Mihomo equivalent.                                                                                                                                               |
| Existing tests and gaps   | Existing tests cover one `http:8080` proxy and reject one non-root subscription URL. Add explicit default ports 80/443, non-default HTTPS, anonymous and encoded credentials, root-path query ambiguity, query rejection/warning policy, TLS fields, IPv6, userinfo security handling, and loss tests for sing-box `path`.                                             |

## Historical pre-implementation fake-input evidence

These inputs were evaluated directly through `parseProxyUriList` against the
frozen pre-implementation snapshot. Expected target failures are additionally
grounded in the pinned Mihomo source above; the adopted behavior is covered by
the current regression suite.

| Finding  | Fake input                                                                                                                                              | Pre-implementation observable result                 | Required result or diagnostic                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `QM-001` | `hysteria://h1.example.test:443?upmbps=10&downmbps=20&obfs=xplus&obfsParam=fake-obfs#H1`                                                                | Emits `obfs: xplus`; drops `obfsParam`               | Emit Mihomo `obfs: fake-obfs`; retain mode only as source metadata if needed      |
| `QM-002` | `hysteria://h1.example.test:443?auth=fake#missing-speed`                                                                                                | Parser succeeds without `up`/`down`                  | Reject before Mihomo's `invalid upload/download speed` path                       |
| `QM-003` | `hysteria2://fake-auth@hy2.example.test:443?ech=ZmFrZS1lY2g%3D#HY2`                                                                                     | Parser succeeds and drops `ech`                      | Build `ech-opts` then let target validate the Base64 ECHConfigList                |
| `QM-013` | `hy2://fake-auth@hy2.example.test:443;8443#semi`                                                                                                        | Emits `ports: 443;8443`                              | Reject or normalize to target-supported comma syntax before output                |
| `QM-004` | `hysteria2+realm://fake-token@realm.example.test/fake-realm?auth=fake-auth&stun=stun1.example.test:3478&stun=stun2.example.test:3478&lport=45000#Realm` | Unsupported scheme                                   | Preserve both STUN entries; diagnose `lport` unsupported in pinned Mihomo         |
| `QM-005` | `tuic://fake-v4-token@tuic.example.test:443#TUIC-v4`                                                                                                    | Emits `uuid: fake-v4-token`, empty password          | For a declared v4 URI dialect, emit `token` and no UUID/password                  |
| `QM-011` | `snell://fake-psk@snell.example.test:443?version=bogus#Snell`                                                                                           | Object contains `version: NaN`; JSON displays `null` | Reject non-integer/unsupported version                                            |
| `QM-008` | `socks5://dXNlcjpwYXNz:literal-pass@socks.example.test:1080#SOCKS`                                                                                      | Emits decoded `user`/`pass`                          | Explicit URL password must disable Base64 shorthand or ambiguity must be rejected |
| `QM-007` | `wireguard://<fake-zero-key>@wg.example.test:51820?public-key=<fake-key>&address=10.0.0.2%2F32&allowed-ips=0.0.0.0%2F0&allowed-ips=10.0.0.0%2F8#WG`     | Emits scalar `allowed-ips: 10.0.0.0/8`               | Preserve list in structural peer or reject unrepresentable flat semantics         |
| `QM-009` | `https://fake-user:fake-pass@proxy.example.test:443#HTTPS-default`                                                                                      | `http proxy requires explicit port`                  | Recognize that `:443` was explicitly present before URL normalization             |
| `QM-010` | `https://fake-user:fake-pass@sub.example.test:8443/?token=fake#ambiguous`                                                                               | Accepted as TLS HTTP proxy; query dropped            | Apply an explicit input-context/query policy; do not silently guess               |
| `QM-012` | `anytls://fake-pass@any.example.test?unknown_key=fake#AnyTLS`                                                                                           | Emits `unknown-key: fake`                            | Warn/reject unknown standard URI key or bind it to an explicit extension dialect  |

`<fake-zero-key>` in the table represents a generated all-zero 32-byte Base64
test value, not a usable or secret WireGuard key.

## Cross-cutting type, repeat, and decode rules

1. `paramsToRecord(URLSearchParams)` and `parseQueryString` both implement
   last-value-wins records. That is incompatible with Realm `stun` and
   WireGuard peer `AllowedIPs` where repetition is semantically meaningful.
2. Percent decoding is not uniform: URL-backed families use WHATWG URL
   normalization, while Hysteria 2 uses a hand parser and `safeDecode`. Preserve
   raw authority evidence when explicit default ports or delimiter validity
   matters.
3. Booleans are protocol-specific. Official H2/AnyTLS use `1`/`0`; accepting
   `true`/`false` can be a named extension but must not be documented as the
   official grammar.
4. Generic `_` -> `-` normalization is unbounded, but target structures are
   bounded. Unknown Mihomo keys are ignored, so passthrough is not lossless
   support and should never satisfy a compatibility matrix row by itself.
5. Mihomo's weak decoder accepts numeric strings for integer fields, but this
   does not make strings the canonical provider type. It never converts a
   scalar string into `[]string`.
6. A URI importer should validate target enums and required combinations before
   generating provider YAML. Deferring every error to core construction makes
   subscription diagnostics detached from the offending line and risks cached
   invalid providers.

## Historical recommended implementation order

Items 1, 2, and 4-9 below were completed by the implementation pass, with the
explicit v5-only TUIC and flat full-tunnel WireGuard policies described above.
Item 3 remains intentionally unsupported; Realm was not registered or folded
into ordinary Hysteria 2.

1. Fix `QM-001` and `QM-002` together with direct official H1 fixtures.
2. Add H2 `ech` structural mapping and gecko validation; separately decide
   whether officially forbidden bandwidth keys are rejected or classified as a
   named extension.
3. Implement Realm as a separate parser, using a multi-value query
   representation; reject or explicitly report `lport` for Mihomo v1.19.28.
4. Define the supported TUIC URI dialect before adding v4. Do not infer a
   universal standard from Sub-Store or one client.
5. Validate Snell versions and required obfuscation combinations.
6. Replace WireGuard scalar passthrough with a typed dialect. Choose full
   `peers` for any input that contains `allowed-ips` or multiple peers.
7. Make SOCKS Base64 shorthand conditional on the absence of an explicit URL
   password, or reject the ambiguous case.
8. Preserve raw HTTP authority long enough to detect explicit 80/443, and make
   the root-path query/origin ambiguity a declared caller policy.
9. Replace AnyTLS/WireGuard arbitrary passthrough with known typed extension
   sets plus an unknown-key diagnostic.

## Historical test matrix and remaining gaps

The implementation pass added protocol-focused regression blocks for the
committed boundaries above. Rows that require an uncommitted dialect (Realm,
WireGuard structural peers/DNS, TUIC v4, Snell ShadowTLS) remain unsupported
rather than being represented lossily.

| Family     | Required positive matrix                                              | Required negative/loss matrix                                                                                |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Hysteria 1 | Official complete URI, three protocols, auth/SNI/ALPN, XPlus password | Missing speed, bad speed, mode without password, `hy` policy, duplicate keys                                 |
| Hysteria 2 | aliases, userpass auth, multi-port, salamander, gecko, pin, ECH       | missing obfs password, invalid ranges, malformed auth/percent, unknown obfs, forbidden bandwidth policy      |
| Realm      | HTTPS/HTTP schemes, token/auth split, repeated STUN                   | empty realm, port hopping, invalid lport, pinned-target lport loss, duplicate singleton keys                 |
| TUIC       | valid v5 UUID/password; documented v4 token dialect if supported      | v4/v5 mixing, bad UUID, missing password, enum/boolean/type failures, sing-box v4 loss                       |
| Snell      | omitted + v1-v5, HTTP/TLS, UDP compatibility                          | NaN/float/out-of-range, unknown obfs, incomplete ShadowTLS, unsupported targets                              |
| AnyTLS     | official minimal, default 443, encoded auth/name, exact 0/1           | unknown addon, duplicate keys, invalid timing, nonstandard extension target loss                             |
| WireGuard  | typed flat full-tunnel, typed peers, v4/v6, PSK, DNS arrays           | missing address/key, invalid Base64/reserved, repeat collapse, scalar slice, flat AllowedIPs source conflict |
| SOCKS      | anonymous/plain/Base64 dialect, IPv6                                  | Base64 collision, explicit-password precedence, unsupported versions/TLS, UDP policy                         |
| HTTP(S)    | non-default ports, explicit 80/443, IPv6, encoded auth                | path, root query ambiguity, ignored TLS query, userinfo policy, sing-box path loss                           |

## Integration decisions taken

1. Strictness is family-specific and evidence-backed: H1 and AnyTLS validate
   their committed grammar; existing named H2 aliases/extensions remain, but
   invalid target combinations fail before YAML generation.
2. Realm remains unsupported for this target pass. Neither Realm scheme is
   registered, so repeated `stun` and unsupported `lport` cannot be silently
   lost through an ordinary H2 parser.
3. ProxyManager promises only the documented TUIC v5 URI dialect. Token-only
   v4 authority is rejected instead of producing a zero/invalid v5 identity.
4. WireGuard URI support is deliberately one peer and full tunnel. Structural
   `peers`, `allowed-ips`, and `dns` claims are rejected; a future structural
   dialect must be designed separately.
5. HTTP(S) proxy URIs require a raw explicit port and contain neither path nor
   query. This does not make `http` an IANA proxy-share scheme, but it provides
   a deterministic fail-closed boundary for the current importer.
