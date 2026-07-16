# Standards and version ledger

Audit date: 2026-07-15

> Historical baseline research draft. Source excerpts and version pins remain
> evidence, but every pending/open/current-status statement in this notebook is
> superseded by `../sources.md`, `../parameter-matrix.csv`,
> `../findings.md`, and `../validation.md`.

This workstream is a read-only standards notebook for the integration owner. It
does not change parser behaviour. No official binary was downloaded or executed
during this phase, so binary evidence (`E4`) remains pending.

## Evidence levels

The ordering follows the audit evidence policy. A lower-numbered level has
priority when sources disagree, but a version-pinned implementation can still
prove that a documented value does not behave as described in a particular
release.

| Level | Evidence                                                                | Version requirement                                                     | Intended use                                                               |
| ----- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `E1`  | Protocol or share-link specification maintained by the protocol project | Fixed revision when available; otherwise retrieval date                 | URI grammar and normative semantics                                        |
| `E2`  | Official target documentation                                           | Documentation commit when available; otherwise retrieval date           | Target configuration fields and documented defaults                        |
| `E3`  | Official source at a fixed release commit                               | Full commit SHA                                                         | Exact accepted fields, branches, defaults, and validation errors           |
| `E4`  | Official release binary with an independently recorded SHA-256          | Exact asset name, release tag, digest, platform, and `--version` output | Resolve documentation/source ambiguity and validate generated full configs |
| `E5`  | Ecosystem converter or client at a fixed commit                         | Full commit SHA                                                         | Differential interoperability only; never a protocol standard              |

All web sources below were retrieved on 2026-07-15. Mutable documentation and
GitHub Discussions must be rechecked before a later audit.

## Latest stable release ledger

For this table, “latest stable” means the release returned by the repository's
official GitHub `releases/latest` endpoint with `draft=false` and
`prerelease=false`. The commit is the commit resolved by the release tag, not
the repository default branch.

| Project    | Latest stable | Published (UTC)     | Release commit                                                                                                                           | Official release and metadata                                                                                                                                 | Boundary note                                                                                                         |
| ---------- | ------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Mihomo     | `v1.19.28`    | 2026-07-08 00:34:38 | [`cbd11db1e13a75d8e680e0fe7742c95be4cba2be`](https://github.com/MetaCubeX/mihomo/commit/cbd11db1e13a75d8e680e0fe7742c95be4cba2be)        | [release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.28), [latest API](https://api.github.com/repos/MetaCubeX/mihomo/releases/latest)             | Committed output target                                                                                               |
| Xray-core  | `v26.3.27`    | 2026-03-27 17:51:11 | [`d2758a023cd7f4174a5a5fa4ff66e487d4342ba0`](https://github.com/XTLS/Xray-core/commit/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0)          | [release](https://github.com/XTLS/Xray-core/releases/tag/v26.3.27), [latest API](https://api.github.com/repos/XTLS/Xray-core/releases/latest)                 | Releases `v26.4.13` through `v26.7.11` visible on 2026-07-15 are all `prerelease=true`; do not call `v26.7.11` stable |
| sing-box   | `v1.13.14`    | 2026-06-25 09:11:52 | [`25a600db24f7680ad9806ce5427bd0ab8afe1114`](https://github.com/SagerNet/sing-box/commit/25a600db24f7680ad9806ce5427bd0ab8afe1114)       | [release](https://github.com/SagerNet/sing-box/releases/tag/v1.13.14), [latest API](https://api.github.com/repos/SagerNet/sing-box/releases/latest)           | Comparison target only                                                                                                |
| v2ray-core | `v5.51.2`     | 2026-05-18 17:39:28 | [`59950bd0b02c482ee88f4c7fe1aeb1e48db7e286`](https://github.com/v2fly/v2ray-core/commit/59950bd0b02c482ee88f4c7fe1aeb1e48db7e286)        | [release](https://github.com/v2fly/v2ray-core/releases/tag/v5.51.2), [latest API](https://api.github.com/repos/v2fly/v2ray-core/releases/latest)              | Comparison target only                                                                                                |
| Sub-Store  | `2.36.7`      | 2026-07-15 08:56:02 | [`0882a5222913aa48d6509ef471a0185d7e07f3d9`](https://github.com/sub-store-org/Sub-Store/commit/0882a5222913aa48d6509ef471a0185d7e07f3d9) | [release](https://github.com/sub-store-org/Sub-Store/releases/tag/2.36.7), [latest API](https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest) | `E5` ecosystem oracle, not standards authority                                                                        |

Tag-to-commit verification endpoint pattern:

```text
https://api.github.com/repos/<owner>/<repo>/commits/<tag>
```

## Official source index

### Mihomo configuration and source

| Evidence                    | Fixed revision                                       | Direct source                                                                                                                                                                                                                                                                                                                                                                                                                                           | Relevant file, type, or function                                                                                                                            | What it establishes                                                                                                               |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `E2` common proxy fields    | Meta-Docs `ee16d1c9b199a341992861eed0e013389dd09441` | [rendered docs](https://wiki.metacubex.one/en/config/proxies/), [source](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/index.en.md)                                                                                                                                                                                                                                                          | Common fields including `name`, `type`, `server`, `port`, `ip-version`, `udp`, `interface-name`, `routing-mark`, `tfo`, `mptcp`, `dialer-proxy`, and `smux` | Candidate fields for a Mihomo proxy object; protocol pages still control applicability                                            |
| `E2` VLESS                  | Meta-Docs `ee16d1c9b199a341992861eed0e013389dd09441` | [rendered docs](https://wiki.metacubex.one/en/config/proxies/vless/), [source](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/vless.en.md#L40-L74)                                                                                                                                                                                                                                            | `uuid`, `flow`, `packet-encoding`, `encryption`, `network`                                                                                                  | Documented VLESS YAML surface; contains a packet-encoding conflict with pinned source, described below                            |
| `E2` WireGuard              | Meta-Docs `ee16d1c9b199a341992861eed0e013389dd09441` | [rendered docs](https://wiki.metacubex.one/en/config/proxies/wg/), [source](https://github.com/MetaCubeX/Meta-Docs/blob/ee16d1c9b199a341992861eed0e013389dd09441/docs/config/proxies/wg.en.md#L1-L79)                                                                                                                                                                                                                                                   | “Simplified syntax” and `peers` full syntax                                                                                                                 | Flat one-peer syntax remains supported; `peers` is required to represent multiple peers without loss                              |
| `E2` Hysteria 2             | Meta-Docs `4653bdc9d4a0594f54afd64bd31d33eb1762455e` | [rendered docs](https://wiki.metacubex.one/en/config/proxies/hysteria2/), [source](https://github.com/MetaCubeX/Meta-Docs/blob/4653bdc9d4a0594f54afd64bd31d33eb1762455e/docs/config/proxies/hysteria2.en.md)                                                                                                                                                                                                                                            | `ech-opts`, `obfs`, `realm-opts`                                                                                                                            | Current Mihomo Hysteria 2 YAML fields                                                                                             |
| `E2` TLS, ECH, Reality      | Meta-Docs `89ff9d82a034eb055d855d5e055235d23973ac6d` | [rendered docs](https://wiki.metacubex.one/en/config/proxies/tls/), [source](https://github.com/MetaCubeX/Meta-Docs/blob/89ff9d82a034eb055d855d5e055235d23973ac6d/docs/config/proxies/tls.en.md#L117-L151)                                                                                                                                                                                                                                              | `reality-opts`, `ech-opts`                                                                                                                                  | Non-empty Reality options enable Reality; ECH config is base64 or can be resolved by DNS                                          |
| `E3` VLESS construction     | Mihomo `cbd11db1e13a75d8e680e0fe7742c95be4cba2be`    | [`adapter/outbound/vless.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/vless.go#L50-L79), [`NewVless`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/vless.go#L421-L470)                                                                                                                                                                 | `VlessOption`, `NewVless`                                                                                                                                   | Exact YAML tags and actual packet-encoding branch                                                                                 |
| `E3` VLESS encryption       | Mihomo `cbd11db1e13a75d8e680e0fe7742c95be4cba2be`    | [`transport/vless/encryption/factory.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/transport/vless/encryption/factory.go#L10-L60)                                                                                                                                                                                                                                                                              | `encryption.NewClient`                                                                                                                                      | Empty and `none` disable encryption; supported ML-KEM/X25519 strings are parsed strictly; unknown values error                    |
| `E3` Reality                | Mihomo `cbd11db1e13a75d8e680e0fe7742c95be4cba2be`    | [`adapter/outbound/reality.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/reality.go#L13-L47)                                                                                                                                                                                                                                                                                                  | `RealityOptions.Parse`                                                                                                                                      | Empty `public-key` returns `(nil, nil)` instead of enabling Reality; invalid non-empty keys error                                 |
| `E3` WireGuard              | Mihomo `cbd11db1e13a75d8e680e0fe7742c95be4cba2be`    | [`adapter/outbound/wireguard.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/wireguard.go#L57-L86), [`NewWireGuard`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/wireguard.go#L167-L257)                                                                                                                                                 | `WireGuardOption`, `WireGuardPeerOption`, `NewWireGuard`                                                                                                    | Flat peer fields are used when `peers` is empty; `peers` entries are used when present; every structured peer needs `allowed-ips` |
| `E3` Hysteria 2, ECH, Realm | Mihomo `cbd11db1e13a75d8e680e0fe7742c95be4cba2be`    | [`adapter/outbound/hysteria2.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/hysteria2.go#L40-L87), [`NewHysteria2`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/hysteria2.go#L126-L300), [`adapter/outbound/ech.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/ech.go#L12-L40) | `Hysteria2Option`, `Hysteria2RealmOption`, `ECHOptions.Parse`                                                                                               | Structural ECH and Realm mappings and their validation behaviour                                                                  |
| `E3` CLI validation         | Mihomo `cbd11db1e13a75d8e680e0fe7742c95be4cba2be`    | [`main.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/main.go#L60-L77), [test branch](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/main.go#L175-L190)                                                                                                                                                                                                                      | `-f`, `-t`                                                                                                                                                  | Fixed command is `mihomo -t -f <full-config.yaml>`                                                                                |

### Xray-core VLESS and sharing

| Evidence                             | Fixed revision                                       | Direct source                                                                                                                                                                                                                                                                                             | Relevant file, type, or function              | What it establishes                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `E1` protocol description            | Retrieved 2026-07-15                                 | [VLESS protocol](https://xtls.github.io/en/development/protocols/vless.html)                                                                                                                                                                                                                              | VLESS request/response protocol               | Protocol framing; it is not by itself a URI standard                                                                                |
| `E2` mutable official share proposal | Retrieved 2026-07-15                                 | [Xray-core Discussion #716](https://github.com/XTLS/Xray-core/discussions/716)                                                                                                                                                                                                                            | VMess AEAD / VLESS sharing proposal           | Query ordering, duplicate prohibition, case sensitivity, VLESS `encryption`, transport `security`, TLS, ECH, and Reality URI fields |
| `E2` configuration docs              | Retrieved 2026-07-15                                 | [VLESS outbound](https://xtls.github.io/en/config/outbounds/vless.html)                                                                                                                                                                                                                                   | VLESS user `encryption` and outbound settings | Current documented Xray configuration surface; documentation is not tied to the stable tag                                          |
| `E3` VLESS validation                | Xray-core `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0` | [`infra/conf/vless.go`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/infra/conf/vless.go#L314-L363)                                                                                                                                                                    | `VLessOutboundConfig.Build`                   | Empty encryption is rejected; `none` and supported ML-KEM/X25519 values are accepted                                                |
| `E3` TLS and Reality validation      | Xray-core `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0` | [`REALITYConfig.Build`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/infra/conf/transport_internet.go#L926-L965), [`StreamConfig.Build`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/infra/conf/transport_internet.go#L1746-L1795) | `REALITYConfig.Build`, `StreamConfig.Build`   | Missing Reality password/public key and unknown `security` are rejected                                                             |
| `E3` CLI validation                  | Xray-core `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0` | [`main/run.go`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/main/run.go#L25-L88)                                                                                                                                                                                      | `cmdRun`, `-test`, `-c`                       | Fixed command is `xray run -test -c <config.json>`                                                                                  |

The sharing proposal is maintained inside a mutable Discussion rather than a
versioned specification file. It states that query-field order is irrelevant,
duplicate occurrences of the same field are forbidden, values are URI encoded,
and parameter names and constants are case-sensitive. That makes it stronger
than an ecosystem convention but weaker for reproducibility than tagged source.

### sing-box

| Evidence                | Fixed revision                                      | Direct source                                                                                                                                                                                                                                                                                                               | Relevant file, type, or function            | What it establishes                                                                                                                         |
| ----------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2` outbound docs      | Retrieved 2026-07-15                                | [outbound configuration](https://sing-box.sagernet.org/configuration/outbound/), [VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/), [Hysteria 2](https://sing-box.sagernet.org/configuration/outbound/hysteria2/), [WireGuard endpoint](https://sing-box.sagernet.org/configuration/endpoint/wireguard/) | Current documented target surface           | Comparison target semantics                                                                                                                 |
| `E3` VLESS options      | sing-box `25a600db24f7680ad9806ce5427bd0ab8afe1114` | [`option/vless.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/vless.go#L17-L27)                                                                                                                                                                                             | `VLESSOutboundOptions`                      | There is no VLESS `encryption` field in this stable release                                                                                 |
| `E3` packet encoding    | sing-box `25a600db24f7680ad9806ce5427bd0ab8afe1114` | [`protocol/vless/outbound.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/protocol/vless/outbound.go#L76-L88)                                                                                                                                                                       | VLESS outbound constructor                  | Omitted means XUDP; explicit empty means raw; `packetaddr` and `xudp` are accepted; unknown values error                                    |
| `E3` Hysteria 2 options | sing-box `25a600db24f7680ad9806ce5427bd0ab8afe1114` | [`option/hysteria2.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/hysteria2.go#L112-L124), [pinned docs](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/docs/configuration/outbound/hysteria2.md#L84-L88)                               | `Hysteria2OutboundOptions`, `Hysteria2Obfs` | Stable target has one generic obfs type/password object; official stable docs document `salamander`, not Mihomo's current `gecko` extension |
| `E3` WireGuard endpoint | sing-box `25a600db24f7680ad9806ce5427bd0ab8afe1114` | [`option/wireguard.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/option/wireguard.go#L9-L30)                                                                                                                                                                                      | `WireGuardEndpointOptions`, `WireGuardPeer` | WireGuard is an endpoint with address, private key, and structural peers                                                                    |
| `E3` CLI validation     | sing-box `25a600db24f7680ad9806ce5427bd0ab8afe1114` | [`cmd_check.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/cmd/sing-box/cmd_check.go#L12-L42), [`cmd.go`](https://github.com/SagerNet/sing-box/blob/25a600db24f7680ad9806ce5427bd0ab8afe1114/cmd/sing-box/cmd.go#L27-L36)                                                          | `commandCheck`, persistent `-c` flag        | Fixed command is `sing-box check -c <config.json>`                                                                                          |

### v2ray-core

| Evidence            | Fixed revision                                        | Direct source                                                                                                                                                       | Relevant file, type, or function | What it establishes                                                                                                                  |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `E3` VLESS          | v2ray-core `59950bd0b02c482ee88f4c7fe1aeb1e48db7e286` | [`infra/conf/v4/vless.go`](https://github.com/v2fly/v2ray-core/blob/59950bd0b02c482ee88f4c7fe1aeb1e48db7e286/infra/conf/v4/vless.go#L122-L172)                      | `VLessOutboundConfig.Build`      | The only accepted VLESS encryption value is exactly `none`; empty and non-`none` values error                                        |
| `E3` packetaddr     | v2ray-core `59950bd0b02c482ee88f4c7fe1aeb1e48db7e286` | [`common/net/packetaddr/config.proto`](https://github.com/v2fly/v2ray-core/blob/59950bd0b02c482ee88f4c7fe1aeb1e48db7e286/common/net/packetaddr/config.proto#L9-L12) | `PacketAddrType`                 | Defines only `None` and `Packet`; it is not XUDP equivalence evidence                                                                |
| `E3` CLI validation | v2ray-core `59950bd0b02c482ee88f4c7fe1aeb1e48db7e286` | [`main/commands/test.go`](https://github.com/v2fly/v2ray-core/blob/59950bd0b02c482ee88f4c7fe1aeb1e48db7e286/main/commands/test.go#L9-L58)                           | `CmdTest`                        | Current v5 command is `v2ray test -c <config.json>`; the old `v2ray -test -config ...` form must not be used for this pinned release |

### Hysteria 2 URI and Shadowsocks SIP002

| Evidence                           | Fixed revision                                                                             | Direct source                                                                                                                                                                              | Relevant section                                                | What it establishes                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `E1` Hysteria 2 URI                | Official docs retrieved 2026-07-15                                                         | [URI Scheme](https://v2.hysteria.network/docs/developers/URI-Scheme/)                                                                                                                      | Standard and Realm structures, parameters, implementation notes | `hysteria2`/`hy2`, auth, multi-port host, `obfs`, `insecure`, `pinSHA256`, `ech`, and distinct Realm schemes                |
| `E2` Hysteria 2 full client config | Official docs retrieved 2026-07-15                                                         | [Full Client Config](https://v2.hysteria.network/docs/advanced/Full-Client-Config/)                                                                                                        | TLS, ECH, transport, and local settings                         | Distinguishes shareable connection data from client-local settings                                                          |
| `E1` Shadowsocks SIP002            | Wiki repository HEAD `6e710da52f08ead893ca84ebe5db3aa98d80c332`; page retrieved 2026-07-15 | [SIP002 URI Scheme](https://github.com/shadowsocks/shadowsocks-org/wiki/SIP002-URI-Scheme), [wiki history](https://github.com/shadowsocks/shadowsocks-org/wiki/SIP002-URI-Scheme/_history) | URI grammar, userinfo encodings, plugin, fragment               | Normative Shadowsocks URI grammar; the repository HEAD identifies the wiki checkout, while the page history remains mutable |

### Sub-Store differential oracle

Sub-Store is `E5` only. Its fixed commit is useful for finding ecosystem
expectations and loss points, but acceptance there does not make a parameter
standard.

| Fixed revision                             | Direct source                                                                                                                                                                      | Relevant parser or producer | Use                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `0882a5222913aa48d6509ef471a0185d7e07f3d9` | [`parsers/index.js`](https://github.com/sub-store-org/Sub-Store/blob/0882a5222913aa48d6509ef471a0185d7e07f3d9/backend/src/core/proxy-utils/parsers/index.js#L905-L980)             | `URI_VLESS`                 | Differential VLESS parsing                                                 |
| same                                       | [`parsers/index.js`](https://github.com/sub-store-org/Sub-Store/blob/0882a5222913aa48d6509ef471a0185d7e07f3d9/backend/src/core/proxy-utils/parsers/index.js#L2153-L2235)           | `URI_Hysteria2`             | Accepts only `hysteria2`/`hy2` at this commit, not the newer Realm schemes |
| same                                       | [`producers/clashmeta.js`](https://github.com/sub-store-org/Sub-Store/blob/0882a5222913aa48d6509ef471a0185d7e07f3d9/backend/src/core/proxy-utils/producers/clashmeta.js)           | Clash Meta producer         | Differential Mihomo output only                                            |
| same                                       | [`producers/sing-box.js`](https://github.com/sub-store-org/Sub-Store/blob/0882a5222913aa48d6509ef471a0185d7e07f3d9/backend/src/core/proxy-utils/producers/sing-box.js#L1433-L1443) | sing-box producer           | Explicitly rejects non-`none` VLESS encryption                             |
| same                                       | [`producers/uri.js`](https://github.com/sub-store-org/Sub-Store/blob/0882a5222913aa48d6509ef471a0185d7e07f3d9/backend/src/core/proxy-utils/producers/uri.js)                       | URI producer                | Differential round-trip evidence only                                      |

## High-risk conclusions

### 1. VLESS `encryption` must remain a byte-sensitive, target-aware value

Evidence:

- The current Xray sharing proposal says omitted VLESS `encryption` defaults to
  `none`, but an explicitly empty value is invalid. It currently names `none`
  and the `mlkem768x25519...` family.
- Xray-core `v26.3.27` rejects empty and unsupported values and accepts explicit
  `none` or a structurally valid ML-KEM/X25519 value.
- Mihomo `v1.19.28` deliberately accepts both empty and `none` as disabled, and
  parses the long ML-KEM/X25519 value. Its error path includes the full input
  string, so application diagnostics must redact the value rather than echo it.
- v2ray-core `v5.51.2` accepts only explicit `none`.
- sing-box `v1.13.14` has no VLESS encryption field. A non-`none` value cannot be
  translated to this target without semantic loss.

Audit rule:

1. Preserve “absent” separately from an explicit string in the neutral parse
   model.
2. URI-decode the value exactly once and preserve the resulting string exactly;
   do not split, truncate, normalize case, or log it.
3. Reject an explicitly empty URI value. Omitted may normalize semantically to
   `none` when producing a target that requires an explicit value.
4. Mihomo and pinned Xray may receive a validated non-`none` value. Pinned
   v2ray-core and sing-box must reject it rather than silently emit `none`.

### 2. VLESS packet encoding has a confirmed Mihomo documentation/source conflict

Evidence:

- Mihomo Meta-Docs at `ee16d1c...` say an empty `packet-encoding` means raw,
  with `packetaddr` and `xudp` as the named values.
- Mihomo source at `cbd11db...`, `NewVless`, selects packetaddr only for
  `packetaddr`/`packet`. Every other string, including empty, `xudp`, and an
  unknown value, falls into the default branch and enables XUDP unless the
  legacy `packet-addr` boolean is already true.
- sing-box `v1.13.14` is different: omitted means XUDP, explicit empty means raw,
  `packetaddr`/`xudp` are accepted, and unknown values are rejected.
- v2ray-core's pinned packet-address type has `None` and `Packet`; that is not
  evidence that it implements XUDP semantics.
- The inspected Xray sharing proposal does not define a canonical
  `packet-encoding` URI query field. Spellings observed in clients must be
  classified as ecosystem extensions until a stronger source is found.

Audit rule:

- For Mihomo output, emit only an explicit, validated `xudp` or `packetaddr`
  when that semantic is requested. Reject unknown URI values instead of relying
  on Mihomo's default-to-XUDP branch.
- Do not claim that empty produces raw on Mihomo `v1.19.28` until a checksum-
  pinned official binary test proves otherwise. The fixed source says it does
  not.
- Keep raw, packetaddr, and XUDP as distinct canonical semantics. Do not treat
  v2ray packetaddr as XUDP.

### 3. Reality must fail closed; `security=reality` without `pbk` is not TLS

Evidence:

- The Xray sharing proposal requires non-empty `pbk` and `fp` when Reality is
  used. Current wording maps URI `pbk` to Xray's `password` field; Mihomo's YAML
  field remains `reality-opts.public-key`.
- Xray-core `v26.3.27` rejects an empty Reality password/public key and validates
  its decoded length.
- At constructor level, Mihomo `RealityOptions.Parse` returns `(nil, nil)`
  when `public-key` is empty. Fixed config decoding rejects a present
  `reality-opts` mapping with an unset `public-key`; however, omitting
  `reality-opts` entirely is accepted as ordinary TLS.

Audit rule:

- When URI `security` is `reality`, require a non-empty, correctly decoded `pbk`
  and the required `fp` before generating YAML. Reject missing or invalid input.
- Never create an empty `reality-opts` object and never silently downgrade the
  node to ordinary TLS. Translate `pbk` to Mihomo `public-key` only after
  validation.

### 4. Unknown or empty VLESS `security` must be rejected

Evidence:

- The Xray sharing proposal names exactly `none`, `tls`, and `reality`; omission
  defaults to `none`, but an explicitly empty value is invalid. Its parameter
  names and constants are case-sensitive.
- Xray-core `v26.3.27` lower-cases its configuration value internally, accepts
  empty/`none`, `tls`, and `reality`, and returns `Unknown security` for every
  other value. Runtime case folding is not permission to broaden the URI
  standard.

Audit rule:

- Whitelist the exact standard URI constants. Treat omission as the documented
  default, but reject explicit empty and unknown values.
- Never map an unknown value to `tls: false`, ordinary TLS, or Reality. This is a
  fail-closed security boundary, not an ignorable extension point.

### 5. Mihomo flat WireGuard fields are still valid for one peer

Evidence:

- Current Meta-Docs explicitly call flat `server`, `port`, `public-key`,
  `pre-shared-key`, `reserved`, and `allowed-ips` the simplified one-peer
  syntax.
- Current docs and source support `peers` for full/multi-peer syntax. When
  `peers` is present, peer-specific top-level fields are ignored; the private
  key remains top-level.
- Pinned Mihomo source uses the flat embedded peer only when `peers` is empty.
  It requires `allowed-ips` for every entry in `peers`.
- sing-box `v1.13.14` models WireGuard as an endpoint with structural peers; its
  schema is not a reason to declare Mihomo's flat syntax obsolete.

Audit rule:

- Do not migrate every one-peer Mihomo node solely because `peers` exists.
- A single peer may use the current flat Mihomo syntax. Multiple peers must use
  `peers`; never collapse them into one flat peer.
- Avoid emitting both representations because Mihomo ignores the flat peer when
  `peers` is non-empty, which can hide stale or misleading data.

### 6. Hysteria 2 ECH and Realm are connection semantics, not optional decoration

Evidence:

- The official Hysteria 2 URI standard defines `ech` as the base64 ECH config
  list and says it must match the server configuration.
- Mihomo `v1.19.28` represents this as `ech-opts.enable` plus
  `ech-opts.config`. `ECHOptions.Parse` base64-decodes a supplied config and
  otherwise performs an ECH DNS lookup only when ECH is enabled.
- Realm sharing uses distinct `hysteria2+realm://` and
  `hysteria2+realm+http://` schemes. In Realm mode, userinfo is the rendezvous
  token, path is the realm name, `auth` is the Hysteria credential, `stun` may
  repeat, and `lport` is a local UDP source port.
- Mihomo has structural `realm-opts` fields for enable, server URL, token, realm
  ID, repeated STUN servers, and rendezvous TLS. The pinned struct has no
  `lport` field, so that standard parameter cannot be represented losslessly in
  this Mihomo release.
- The official URI notes explicitly exclude client modes and bandwidth values
  from the standard share URI. Third-party bandwidth keys are extensions, not
  official URI fields.

Audit rule:

- Map ordinary URI `ech=<base64>` to
  `ech-opts: { enable: true, config: <base64> }`; validate base64 and do not
  silently drop it.
- Dispatch the two Realm schemes separately. Do not feed them to an ordinary
  `hysteria2://` parser: token, host, path, and auth have different meanings.
- Preserve every repeated `stun` value in order. Reject unsupported `lport`
  rather than discarding it. Treat bandwidth keys only as explicitly documented
  ecosystem extensions.

### 7. SIP002 parsing must distinguish legacy-looking base64 from AEAD-2022

SIP002 grammar is:

```text
ss://userinfo@hostname:port[/][?plugin][#tag]
```

Normative consequences:

- Base64URL userinfo is recommended but optional for Stream and pre-2022 AEAD.
- AEAD-2022 userinfo must **not** be Base64URL encoded; plain method and password
  must be percent encoded.
- A slash should precede the query when `plugin` is present. The plugin argument
  itself is URI encoded and has its own escaped sub-syntax.
- Unsupported query arguments are ignored by the SIP002 example, while invalid
  core authority/userinfo still must fail.
- Fragment whitespace must be percent encoded. Base64 is transport encoding,
  not encryption, and must never be described or logged as a secret-protection
  mechanism.

## Version-dependent cautions

1. Mihomo's TLS documentation revision `89ff9d...` warns that it will not remain
   compatible with Xray `v26.7.11+` Reality behaviour. On the audit date,
   `v26.7.11` is a prerelease, while the latest stable Xray remains `v26.3.27`.
   Keep “current docs” and “latest stable source” as separate columns.
2. Xray-core stable `v26.3.27` contains a wall-clock removal gate for
   `allowInsecure` after 2026-06-01 in `TLSConfig.Build`; on this audit date a
   pinned stable binary may reject that field. This is Xray comparison-target
   behaviour and must not be projected onto Mihomo's `skip-cert-verify` field.
3. Xray Discussion #716 and the official Hysteria web documentation are
   mutable. The retrieval date is part of every claim until a fixed source
   revision is identified.

## Fixed-binary checksum and validation procedure

No binaries were downloaded in this workstream. The following is the required
procedure for the later `E4` validation phase.

### Record the official asset digest before execution

GitHub's release API currently exposes a `sha256:<hex>` `digest` for release
assets. Select the exact platform asset and save its name, URL, and digest in
the validation ledger before downloading it:

```bash
REPO='MetaCubeX/mihomo'
TAG='v1.19.28'
ASSET='<exact-release-asset-name>'

curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" \
  | jq -r --arg asset "${ASSET}" \
      '.assets[] | select(.name == $asset) | [.name, .browser_download_url, .digest] | @tsv'
```

After downloading through the separately approved validation workflow, compute
the local digest and compare the complete hex value:

```bash
shasum -a 256 '/absolute/path/to/<exact-release-asset-name>'
```

Where a project also publishes a `.dgst` asset, retain both the GitHub asset
digest and the project checksum/signature material. Do not infer the binary
version from its filename alone; record its version output after extraction.

### Version-pinned configuration checks

| Target               | Exact command for the pinned release                                    | Scope                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Mihomo `v1.19.28`    | `'/absolute/path/to/mihomo' -t -f '/absolute/path/to/full-config.yaml'` | Parses a complete Mihomo config and constructs proxy options; a provider-only fragment must first be wrapped in a minimal full config |
| Xray-core `v26.3.27` | `'/absolute/path/to/xray' run -test -c '/absolute/path/to/config.json'` | Parses and constructs the Xray config without starting the server                                                                     |
| sing-box `v1.13.14`  | `'/absolute/path/to/sing-box' check -c '/absolute/path/to/config.json'` | Reads and constructs the sing-box config                                                                                              |
| v2ray-core `v5.51.2` | `'/absolute/path/to/v2ray' test -c '/absolute/path/to/config.json'`     | Current v5 config-test subcommand                                                                                                     |

Core binaries do not validate share URIs directly. The URI must first be parsed
by ProxyManager, rendered into a complete target config, then passed to the
matching fixed binary. A successful config check proves parse/construction
compatibility, not remote connectivity or equivalent runtime semantics.

## Pending `E4` probes and unresolved conflicts

1. Run a checksum-pinned Mihomo `v1.19.28` matrix for VLESS
   `packet-encoding`: omitted, explicit empty, `xudp`, `packetaddr`, and unknown.
   Expected from fixed source: omitted/empty/`xudp`/unknown all select XUDP;
   `packetaddr` selects packetaddr. The unknown case should still be rejected by
   ProxyManager even if Mihomo accepts it.
2. Run valid/invalid long VLESS encryption fixtures on pinned Mihomo and Xray
   binaries without printing the value in logs or snapshots.
3. Prove that `security=reality` without `pbk` is rejected by ProxyManager
   before Mihomo validation. Separately distinguish the fixed target's rejection
   of a present empty `reality-opts` mapping from its acceptance of an omitted
   mapping as ordinary TLS.
4. Validate ordinary Hysteria 2 ECH and Realm output against pinned Mihomo. Keep
   `lport` as explicit unsupported input for `v1.19.28` unless a stronger target
   representation is found.
5. Capture exact platform asset names, GitHub digests, local SHA-256 values, and
   version outputs in the integrated validation ledger. None are claimed here.
