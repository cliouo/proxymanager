# SS, SSR, and VMess URI compatibility audit

Audit date: 2026-07-15

> Historical baseline research draft. `../parameter-matrix.csv`,
> `../findings.md`, and `../validation.md` are authoritative for final UUID,
> HTTPUpgrade, closed-grammar, and validation behavior.

This notebook audits the SS, SSR, and VMess branches in
`web/lib/proxies/uriToClash.ts`. It records evidence and proposed fixes. It does
not change parser or test code.

## Scope and frozen baseline

The behavior baseline is commit
[`9596cec88fb17fd67ed7102b625b18bb92e9f68f`](https://github.com/cliouo/proxymanager/commit/9596cec88fb17fd67ed7102b625b18bb92e9f68f),
not the concurrent audit worktree.

| Parser | Baseline function                                                                                                                                                                 | Lines   | Baseline tests                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SS     | [`parseSS`, `applySsQueryParams`, `attachSsPlugin`](https://github.com/cliouo/proxymanager/blob/9596cec88fb17fd67ed7102b625b18bb92e9f68f/web/lib/proxies/uriToClash.ts#L124-L346) | 124-346 | [`proxyUri.test.ts`](https://github.com/cliouo/proxymanager/blob/9596cec88fb17fd67ed7102b625b18bb92e9f68f/web/tests/subscriptions/proxyUri.test.ts) |
| SSR    | [`parseSSR`](https://github.com/cliouo/proxymanager/blob/9596cec88fb17fd67ed7102b625b18bb92e9f68f/web/lib/proxies/uriToClash.ts#L348-L377)                                        | 348-377 | same test file                                                                                                                                      |
| VMess  | [`parseVMess`](https://github.com/cliouo/proxymanager/blob/9596cec88fb17fd67ed7102b625b18bb92e9f68f/web/lib/proxies/uriToClash.ts#L379-L440)                                      | 379-440 | same test file                                                                                                                                      |

The extracted baseline file had SHA-256
`37ac7740401be6761349ce443013aeed9e2b2cc602048f8399ffff956248a531`.

### Result summary

| Area                         | Result                                                                                        | Highest-risk result                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SS core URI                  | Three deployed forms parse, including official SIP002 and the older whole-payload Base64 form | Port parsing in the frozen baseline accepts numeric prefixes and lacks an upper bound. A separate concurrent strict-port change already touches this shared code. |
| SS plugin                    | Common obfs, v2ray-plugin, and shadow-tls shapes parse                                        | SIP003 escaping is broken. Unknown or unsupported plugins are removed while the node remains accepted.                                                            |
| SS TLS and transport wrapper | Query keys are copied into a Mihomo-shaped map                                                | Mihomo SS does not consume top-level `tls`, `sni`, `network`, or transport option fields. Validation succeeds after those fields are ignored.                     |
| SSR                          | The core six fields and three useful optional fields parse                                    | `group`, `udpport`, and `uot` are dropped. The target cannot represent the latter two with its SSR adapter.                                                       |
| VMess legacy JSON            | Basic TCP, WS, H2, gRPC, and a local HTTPUpgrade mapping parse                                | Fake HTTP, KCP parameters, QUIC, certificate pinning, client fingerprint, and verification-name fields are lost or changed.                                       |
| VMess AEAD URL               | Not supported                                                                                 | Every URL-form VMess AEAD share is rejected before its query fields are inspected.                                                                                |
| VMess scalar types           | Every non-null JSON value is stringified                                                      | Objects and booleans can disable TLS or change `alterId` to zero instead of causing rejection.                                                                    |

## Evidence model and status labels

The parent audit defines `E1` through `E5`. This notebook uses the same order:
protocol or URI specification, official target docs, fixed official source,
fixed official binary, then fixed client or converter behavior.

| Status       | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| `OK`         | The parser preserves the documented semantic in Mihomo output.                              |
| `PARTIAL`    | Common values work, but documented values, aliases, or nested fields are lost.              |
| `DROP`       | The parser accepts the input and omits its semantic.                                        |
| `FALLBACK`   | The parser emits a value that Mihomo accepts but executes as another semantic, usually TCP. |
| `REJECT`     | The parser returns an input error.                                                          |
| `EXTENSION`  | The behavior is a client convention, not part of the cited URI contract.                    |
| `TARGET GAP` | The source format can express the value but Mihomo's protocol adapter cannot.               |
| `UNRESOLVED` | The inspected authorities disagree or do not define a default.                              |

## Fixed source ledger

All web material was retrieved on 2026-07-15. Mutable wiki and Discussion
pages need another review after that date.

| Level | Project and revision                                                    | Direct source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Relevant code or section                                                                                      | Use in this audit                                                                      |
| ----- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `E1`  | shadowsocks-org `34598d65054dad975d330ff9d7317b0d41cf1efd`              | [`sip002.md`](https://github.com/shadowsocks/shadowsocks-org/blob/34598d65054dad975d330ff9d7317b0d41cf1efd/docs/doc/sip002.md), [`sip003.md`](https://github.com/shadowsocks/shadowsocks-org/blob/34598d65054dad975d330ff9d7317b0d41cf1efd/docs/doc/sip003.md), [`configs.md`](https://github.com/shadowsocks/shadowsocks-org/blob/34598d65054dad975d330ff9d7317b0d41cf1efd/docs/doc/configs.md)                                                                                                                                             | SIP002 grammar and examples; SIP003 option escaping and one-plugin restriction; older whole-payload URI       | SS grammar, encoding, plugin delimiter rules, and legacy boundary                      |
| `E2`  | Meta-Docs `824be43699b2b6dcb0c0bf4d7a0412884c7b17c7`                    | [`ss.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/824be43699b2b6dcb0c0bf4d7a0412884c7b17c7/docs/config/proxies/ss.en.md), [`ssr.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/824be43699b2b6dcb0c0bf4d7a0412884c7b17c7/docs/config/proxies/ssr.en.md), [`vmess.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/824be43699b2b6dcb0c0bf4d7a0412884c7b17c7/docs/config/proxies/vmess.en.md), [`tls.en.md`](https://github.com/MetaCubeX/Meta-Docs/blob/824be43699b2b6dcb0c0bf4d7a0412884c7b17c7/docs/config/proxies/tls.en.md) | Protocol option pages                                                                                         | Mihomo output fields and documented defaults                                           |
| `E3`  | Mihomo `v1.19.28`, `cbd11db1e13a75d8e680e0fe7742c95be4cba2be`           | [`converter.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/common/convert/converter.go), [`v.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/common/convert/v.go), [`parser.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/parser.go)                                                                                                                                                                         | `ConvertsV2Ray`, `handleVShareLink`, `ParseProxy`                                                             | Mihomo share conversion and map-to-adapter decoding                                    |
| `E3`  | same Mihomo revision                                                    | [`shadowsocks.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/shadowsocks.go), [`shadowsocksr.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/shadowsocksr.go), [`vmess.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/adapter/outbound/vmess.go), [`structure.go`](https://github.com/MetaCubeX/mihomo/blob/cbd11db1e13a75d8e680e0fe7742c95be4cba2be/common/structure/structure.go) | `ShadowSocksOption`, `ShadowSocksROption`, `VmessOption`, `New*`, decoder                                     | Exact target fields, plugin defaults, unknown-key handling, and transport fallback     |
| `E4`  | Mihomo `v1.19.28` Darwin arm64                                          | [release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.28)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `mihomo-darwin-arm64-v1.19.28.gz`, SHA-256 `40cdae2fab4b18df15f40eaa9dc3af70ab3d8be7f77164ae1e5f1af3a2a4fb44` | Confirms top-level SS wrapper fields and unknown VMess network values pass `mihomo -t` |
| `E2`  | Xray-core Discussion #716, updated 2026-06-13                           | [VMess AEAD and VLESS share proposal](https://github.com/XTLS/Xray-core/discussions/716)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | URL grammar, `encryption`, transport, TLS, and no `aid`                                                       | Mutable modern URL contract                                                            |
| `E3`  | Xray-core stable `v26.3.27`, `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0` | [`infra/conf/vmess.go`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/infra/conf/vmess.go), [`account.proto`](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/proxy/vmess/account.proto)                                                                                                                                                                                                                                                                                   | `VMessAccount`, `VMessOutboundConfig.Build`                                                                   | Xray has no `alterId` field and warns that VMess lacks forward secrecy                 |
| `E3`  | v2ray-core stable `v5.51.2`, `59950bd0b02c482ee88f4c7fe1aeb1e48db7e286` | [`infra/conf/v4/vmess.go`](https://github.com/v2fly/v2ray-core/blob/59950bd0b02c482ee88f4c7fe1aeb1e48db7e286/infra/conf/v4/vmess.go), [`account.proto`](https://github.com/v2fly/v2ray-core/blob/59950bd0b02c482ee88f4c7fe1aeb1e48db7e286/proxy/vmess/account.proto), [`outbound.go`](https://github.com/v2fly/v2ray-core/blob/59950bd0b02c482ee88f4c7fe1aeb1e48db7e286/proxy/vmess/outbound/outbound.go)                                                                                                                                    | `alterId`, security values, AEAD selection                                                                    | A zero alter ID selects AEAD; a nonzero value retains legacy authentication            |
| `E2`  | v2fly docs `96eb7be442e266db831d08f4dfb86c56948ae075`                   | [`VMess protocol`](https://github.com/v2fly/v2fly-github-io/blob/96eb7be442e266db831d08f4dfb86c56948ae075/docs/developer/protocols/vmess.md), [`VMess v5 config`](https://github.com/v2fly/v2fly-github-io/blob/96eb7be442e266db831d08f4dfb86c56948ae075/docs/v5/config/proxy/vmess.md)                                                                                                                                                                                                                                                      | Authentication and configuration pages                                                                        | MD5 authentication is deprecated; AEAD remains supported                               |
| `E5`  | Sub-Store `2.36.7`, `0882a5222913aa48d6509ef471a0185d7e07f3d9`          | [`parsers/index.js`](https://github.com/sub-store-org/Sub-Store/blob/0882a5222913aa48d6509ef471a0185d7e07f3d9/backend/src/core/proxy-utils/parsers/index.js)                                                                                                                                                                                                                                                                                                                                                                                 | `URI_SS`, `URI_SSR`, `URI_VMess`                                                                              | Differential client and converter behavior                                             |
| `E5`  | v2rayN wiki `1e98189ad592b13a3a13bd4e5e7e757bee952a65`                  | [VMess share-link page](https://github.com/2dust/v2rayN/wiki/Description-of-VMess-share-link)                                                                                                                                                                                                                                                                                                                                                                                                                                                | Base64 JSON example and raw field descriptions                                                                | Legacy VMess JSON contract and string spellings                                        |
| `E5`  | ShadowsocksR backup wiki `415486e9f462f8977f1a6d2a86eac30a6b289d35`     | [SSR QR-code scheme](https://github.com/shadowsocksr-backup/shadowsocks-rss/wiki/SSR-QRcode-scheme)                                                                                                                                                                                                                                                                                                                                                                                                                                          | Six required fields and six optional query keys                                                               | Archived SSR URI grammar; no maintained formal standard was found                      |
| `E3`  | shadowsocks/v2ray-plugin `e9af1cdd2549d528deb20a4ab8d61c5fbe51f306`     | [`main.go`](https://github.com/shadowsocks/v2ray-plugin/blob/e9af1cdd2549d528deb20a4ab8d61c5fbe51f306/main.go), [`README.md`](https://github.com/shadowsocks/v2ray-plugin/blob/e9af1cdd2549d528deb20a4ab8d61c5fbe51f306/README.md)                                                                                                                                                                                                                                                                                                           | `mode`, `mux`, `tls`, `host`, `path`                                                                          | Plugin-specific option meaning                                                         |

## Contract boundaries

1. SIP002 defines the current SS URI. The shadowsocks-org repository also
   documents the older whole-payload Base64 URI, but SIP002 is the format that
   plugin-capable implementations should use.
2. SIP003 defines option escaping and plugin process behavior. Each plugin
   defines its own option names. SIP003 does not make `type=ws`,
   `security=tls`, or Reality top-level SS fields.
3. The archived SSR wiki is the best located grammar for `ssr://`. Mihomo calls
   its implementation "SSR protocol compatibility." Xray-core and v2ray-core
   do not supply an SSR outbound. This audit does not call SSR globally removed
   or unsupported because Mihomo `v1.19.28` still implements it.
4. Two VMess share formats coexist. v2rayN documents Base64 JSON. The Xray
   proposal defines an ordinary URL for VMess AEAD and explicitly excludes
   `alterId` and `aid`. Mihomo accepts both formats.
5. Xray stable warns that VMess lacks forward secrecy. v2ray-core still
   implements both AEAD and the deprecated MD5 authentication path. These are
   protocol lifecycle facts, not permission to change an imported node's
   `alterId`.

## Shadowsocks

### Core URI forms

| Raw form or field                                  | Aliases                                                 | Semantic and input type                                                                  | Default                                              | Frozen parser behavior                                                       | Status                                                        | Test at baseline                                                      |
| -------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ss://BASE64URL(method:password)@host:port`        | Percent-encoded standard Base64 in deployed links       | SIP002 encoded userinfo                                                                  | Recommended for stream and AEAD                      | Tries Base64, then percent-decoded Base64                                    | `OK` for covered values                                       | Base64URL-compatible userinfo and percent-encoded Base64 are asserted |
| `ss://percent(method):percent(password)@host:port` | none                                                    | SIP002 plain userinfo; both fields must be percent encoded; AEAD-2022 must use this form | Optional for stream and AEAD; required for AEAD-2022 | Falls through to one percent decode, then splits on the first colon          | `OK` for ordinary values; AEAD-2022 rule is untested          | Missing                                                               |
| `ss://BASE64(method:password@host:port)`           | Standard and URL-safe Base64 variants in deployed links | Older whole-payload form                                                                 | none                                                 | Decodes and splits from the last `@` and last `:`                            | `EXTENSION` relative to SIP002, documented by shadowsocks-org | Legacy IPv6 path is asserted                                          |
| `method`                                           | Mihomo calls it `cipher`                                | Non-empty cipher name                                                                    | none                                                 | Accepts any string and leaves final cipher validation to Mihomo              | `PARTIAL`                                                     | No invalid or empty method test                                       |
| `password`                                         | none                                                    | String after the first userinfo colon                                                    | none                                                 | Preserves further colons and `@` characters                                  | `OK`                                                          | Plain special-character password is not asserted at this baseline     |
| `host`                                             | bracketed IPv6                                          | Domain, IPv4, or bracketed IPv6                                                          | none                                                 | Removes brackets and supports legacy IPv6 by end-splitting                   | `OK` plus a legacy extension                                  | SIP002 and legacy IPv6 are asserted                                   |
| `port`                                             | none                                                    | Decimal integer, `1..65535`                                                              | none                                                 | Uses `parseInt`; accepts `443junk`, values above 65535, and numeric prefixes | Baseline `PARTIAL`; concurrent shared strict-port work exists | No invalid-boundary assertion at baseline                             |
| trailing `/`                                       | none                                                    | SIP002 delimiter when `plugin` is present                                                | Required by SIP002 wording when plugin is present    | Removes one trailing slash before host/port parsing                          | `OK`                                                          | Plugin fixture contains `/`                                           |
| `#tag`                                             | none                                                    | Percent-encoded display name                                                             | `host:port`                                          | Decodes once                                                                 | `OK`                                                          | Names are asserted                                                    |
| unsupported query key                              | any name                                                | SIP002 says unsupported arguments should be ignored                                      | ignored                                              | Ignored                                                                      | `OK` only for arguments that do not change the endpoint       | No explicit assertion                                                 |

### SS query and wrapper matrix

| Raw key         | Aliases                            | Canonical semantic                                                        | Raw type and accepted values                              | Default                  | Frozen parser output                                             | Target result                                                                            | Status                                                                  |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `udp`           | none                               | Enable native UDP relay                                                   | String `0`, `false`, `1`, or `true` by convention         | Parser emits `udp: true` | Only `0` and `false` set false                                   | Mihomo SS consumes `udp`                                                                 | `OK`; positive values rely on the default                               |
| `tfo`           | none                               | TCP Fast Open                                                             | `1` or `true`                                             | omitted                  | Emits `tfo: true`                                                | `BasicOption` consumes it                                                                | `OK` for true only                                                      |
| `uot`           | `udp-over-tcp` in Mihomo converter | UDP over TCP                                                              | `1` or `true`                                             | omitted                  | Emits `udp-over-tcp: true` only for `uot`                        | Mihomo SS consumes the output                                                            | `PARTIAL`; raw `udp-over-tcp=true` is missed                            |
| `security`      | none                               | Client-specific outer security wrapper                                    | `none`, `tls`, `reality`; no SS standard defines this key | none                     | Every non-`none` value emits top-level `tls: true`               | Mihomo `ShadowSocksOption` has no top-level TLS fields                                   | `DROP`, with unsafe semantic reporting                                  |
| `sni`           | `peer`                             | Outer TLS server name                                                     | String                                                    | server or plugin-defined | Emits top-level `sni`                                            | Mihomo SS ignores it                                                                     | `DROP`                                                                  |
| `alpn`          | none                               | Outer TLS ALPN list                                                       | Comma-separated string                                    | plugin-defined           | Emits top-level array                                            | Mihomo SS ignores it                                                                     | `DROP`                                                                  |
| `allowInsecure` | `insecure`                         | Disable certificate verification                                          | Parser recognizes only literal `1`                        | false                    | Emits top-level `skip-cert-verify`                               | Mihomo SS ignores it                                                                     | `DROP`                                                                  |
| `fp`            | none                               | Outer TLS client fingerprint                                              | String                                                    | client-defined           | Emits top-level `client-fingerprint`                             | Mihomo SS has this field, but it affects supported plugin paths rather than creating TLS | `PARTIAL`; it cannot make the wrapper work                              |
| `pbk`           | none                               | Reality public key                                                        | String                                                    | none                     | Emits `reality-opts.public-key`                                  | Mihomo SS has no `reality-opts` field                                                    | `DROP`                                                                  |
| `sid`           | none                               | Reality short ID                                                          | String                                                    | empty                    | Emits `reality-opts.short-id`                                    | Mihomo SS ignores it                                                                     | `DROP`                                                                  |
| `type`          | none                               | Client-specific outer transport                                           | `ws`, `h2`, `grpc`, `httpupgrade`, or any string          | absent                   | Emits top-level `network` and a matching option map              | Mihomo SS has no top-level transport fields                                              | `DROP`; unknown values are also copied                                  |
| `path`          | `wspath` with `ws=1`               | Transport path                                                            | String                                                    | `/` in most branches     | Emits path in `ws-opts`, `h2-opts`, or the legacy WS map         | Mihomo SS ignores these top-level maps                                                   | `DROP` without a supported plugin                                       |
| `host`          | none                               | Transport Host header or H2 host list                                     | String                                                    | absent                   | Emits transport-specific host                                    | Mihomo SS ignores it without a plugin                                                    | `DROP` without a supported plugin                                       |
| `serviceName`   | none                               | gRPC service name                                                         | String                                                    | empty                    | Emits `grpc-opts.grpc-service-name`                              | Mihomo SS ignores it                                                                     | `DROP`                                                                  |
| `ws`            | none                               | Legacy WS enable flag                                                     | `1` or `true`                                             | false                    | Emits `network: ws`                                              | Mihomo SS ignores it                                                                     | `DROP`                                                                  |
| `shadow-tls`    | none                               | Shadowrocket JSON payload with host, password, version, address, and port | Base64 JSON                                               | absent                   | Maps to Mihomo's `shadow-tls` plugin and may replace server/port | Mihomo supports this plugin                                                              | `PARTIAL`; malformed payload is ignored and the direct SS node survives |
| `plugin`        | none                               | SIP002 percent-encoded SIP003 plugin argument                             | Plugin name plus semicolon options                        | absent                   | Dispatches three plugin families                                 | Mihomo supports more plugin families than this parser                                    | `PARTIAL`                                                               |

The wrapper fields above come from Sub-Store and deployed client links. They
are not SIP002 fields. Copying their names into a Mihomo SS map does not
implement the wrapper.

### SIP003 and plugin option matrix

| Raw plugin or option                             | Aliases                                    | Semantic and type                                     | Plugin default                                                                           | Frozen parser behavior                          | Mihomo behavior                                        | Status                                                                    |
| ------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Plugin option escape `\\;`, `\\=`, `\\\\`, `\\:` | none                                       | Literal delimiter inside one option value             | none                                                                                     | Splits on every `;` before processing escapes   | Receives an already corrupted option map               | `DROP`; violates SIP002/SIP003                                            |
| `obfs-local`                                     | `simple-obfs`                              | Simple obfs plugin                                    | none                                                                                     | Maps to Mihomo plugin `obfs`                    | Supported modes are `http` and `tls`                   | `OK` for covered modes                                                    |
| `obfs`                                           | none                                       | Simple obfs mode                                      | plugin-defined                                                                           | Maps to `plugin-opts.mode`                      | Mihomo validates the mode                              | `OK`                                                                      |
| `obfs-host`                                      | none                                       | Simple obfs host                                      | plugin-defined                                                                           | Maps to `plugin-opts.host`                      | Consumed                                               | `OK`                                                                      |
| `v2ray-plugin`                                   | `xray-plugin` in this parser               | V2Ray plugin endpoint                                 | none                                                                                     | Both raw names map to Mihomo `v2ray-plugin`     | Mihomo implements only WebSocket mode for this adapter | `PARTIAL`; the `xray-plugin` equivalence is an extension                  |
| `mode`                                           | `obfs` in Mihomo/Sub-Store converters      | V2Ray plugin transport mode                           | Official plugin defaults to `websocket`                                                  | Ignored; output is always `websocket`           | Mihomo rejects a non-WebSocket mode if one reaches it  | `DROP`; `mode=quic` is changed to WebSocket                               |
| `host`                                           | `obfs-host` in Mihomo/Sub-Store converters | V2Ray plugin Host and TLS name                        | Official plugin defaults to `cloudfront.com`; Mihomo defaults to `bing.com` when omitted | Only `host` is read                             | Consumed                                               | `PARTIAL`; the deployed alias is lost and target default changes behavior |
| `path`                                           | none                                       | WebSocket path                                        | Official plugin defaults to `/`                                                          | Copied                                          | Consumed                                               | `OK` until an escaped delimiter appears                                   |
| bare `tls`                                       | none                                       | Enable plugin TLS                                     | false                                                                                    | Presence emits `tls: true`                      | Consumed                                               | `OK`                                                                      |
| `mux`                                            | none                                       | Official plugin integer concurrency; zero disables    | Official plugin defaults to `1`; Mihomo's adapter defaults Boolean `true`                | Only `mux=1` emits `true`; `mux=0` is omitted   | Omission becomes `true`                                | `FALLBACK`; explicit disable becomes enabled                              |
| `shadow-tls` plugin                              | query payload alias above                  | Shadow TLS plugin                                     | Mihomo version defaults to 2                                                             | Maps host, password, and version                | Consumed                                               | `PARTIAL`; other supported plugin fields are not imported                 |
| unknown plugin name                              | none                                       | Endpoint requires a plugin the target may not support | none                                                                                     | Removes the entire plugin and accepts direct SS | Mihomo receives an ordinary SS node                    | `DROP`, fail-open                                                         |
| Mihomo `gost-plugin`, `restls`, `kcptun`         | none                                       | Target-supported plugin families                      | family-specific                                                                          | Not dispatched from SIP002 `plugin=`            | Mihomo supports them                                   | `DROP`; rejection is safer unless support is implemented                  |

### SS findings

#### SS-01: top-level TLS and transport wrappers are accepted but not executed

Severity candidate: `P1` when a link requires certificate or Reality
semantics, otherwise `P2` compatibility.

The parser converts `security=tls&type=ws` into top-level SS fields. Mihomo's
`ShadowSocksOption` contains the SS cipher, password, UDP, plugin, UOT, and
client-fingerprint fields. It contains no top-level `tls`, `sni`, `alpn`,
`network`, `ws-opts`, `h2-opts`, `grpc-opts`, or `reality-opts` fields. The
Mihomo decoder removes recognized keys from its internal unused-key set but
does not return an error for remaining source keys.

The pinned binary accepted this synthetic node:

```yaml
proxies:
  - name: synthetic-ss-wrapper
    type: ss
    server: ss.example.invalid
    port: 443
    cipher: aes-128-gcm
    password: synthetic-password
    tls: true
    sni: cdn.example.invalid
    network: ws
    ws-opts:
      path: /synthetic
      headers:
        Host: cdn.example.invalid
```

`mihomo -t` reported success. Source inspection shows that the SS adapter then
builds a direct SS connection because no supported plugin was configured.

Required guard: reject an SS wrapper that cannot be translated to a supported
Mihomo plugin. Do not emit target fields from another protocol and report the
node as TLS or Reality capable.

#### SS-02: unsupported plugins are stripped from accepted nodes

Severity candidate: `P1` for security-carrying plugins, otherwise `P2`.

For `plugin=future-plugin;mode=tls`, `attachSsPlugin` reaches no branch. The
parser returns an ordinary direct SS node with no error. A malformed
`shadow-tls` payload follows the same fail-open pattern because its catch block
ignores the error.

Required guard: any present plugin or plugin-equivalent payload must produce a
supported target plugin or an input error. The parser must not remove the
endpoint's transport requirement.

#### SS-03: the plugin tokenizer violates SIP003 escaping

Severity candidate: `P2`.

Synthetic decoded plugin argument:

```text
v2ray-plugin;host=cdn.example;path=/socket\;matrix=1
```

SIP003 defines the path value as `/socket;matrix=1`. The frozen parser emits
`plugin-opts.path: "/socket\\"` and treats `matrix=1` as another option.

Required guard: scan the string once, honor backslash escapes for colon,
semicolon, equals, and backslash, and split only on unescaped delimiters.
Malformed trailing escapes should reject the plugin argument.

#### SS-04: v2ray-plugin option mapping changes explicit settings

Severity candidate: `P2`.

The official plugin parses integer `mux`; zero disables it. The frozen parser
omits `mux` for `mux=0`. Mihomo initializes its v2ray plugin option with
`Mux: true`, so omission enables mux. The parser also changes `mode=quic` to
WebSocket and misses the deployed `obfs-host` alias.

Required guard: define a target-specific option map. Preserve Boolean mux
disable, reject target-unrepresentable concurrency and QUIC mode, and accept an
alias only when fixed interoperability evidence supports it.

#### SS-05: the frozen baseline accepts invalid port suffixes and ranges

Severity candidate: `P2`.

`parseInt` turns `443junk` into `443` and accepts values above 65535. A
concurrent audit change already introduced a shared strict port helper, so this
workstream proposes no overlapping source edit. Integration should retain
tests for `0`, `65536`, signs, whitespace, suffixes, and non-decimal input.

### SS test gaps

- AEAD-2022 plain userinfo with its required no-Base64 rule.
- SIP003 escaped semicolon, equals, colon, backslash, and dangling escape.
- Unknown plugin, unsupported v2ray-plugin mode, `mux=0`, and `obfs-host` alias.
- `udp-over-tcp=true` raw alias.
- Top-level TLS, Reality, WS, H2, and gRPC wrappers tested through a fixed
  Mihomo adapter or rejected before rendering. Current unit tests only assert
  the intermediate object, which masks SS-01.
- Malformed `shadow-tls` JSON, missing required plugin fields, and invalid
  server/port overrides.
- Strict method, host, and port validation.

## ShadowsocksR

### Lifecycle and target boundary

The located SSR URI grammar lives in an archived backup wiki, not in a current
protocol specification. It defines URL-safe Base64 without padding and this
decoded shape:

```text
host:port:protocol:method:obfs:base64pass
  /?obfsparam=base64param
  &protoparam=base64param
  &remarks=base64remarks
  &group=base64group
  &udpport=0
  &uot=0
```

The first six fields are required. The entire `/?...` suffix is optional. The
wiki says `udpport` and `uot` were C# client-only extensions at that time.

Mihomo `v1.19.28` still has an SSR adapter. Its fields are server, port,
password, cipher, obfs, obfs-param, protocol, protocol-param, and UDP. The
adapter accepts `none` by mapping it to its dummy cipher and otherwise requires
a supported stream cipher. Xray-core and v2ray-core have no comparable SSR
outbound in the inspected versions.

### SSR parameter matrix

| Raw field    | Aliases                                       | Semantic and type                                                            | Default                                   | Frozen parser behavior                                              | Mihomo result                                                                 | Status                                                                 | Baseline assertion                                          |
| ------------ | --------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Entire body  | Padded Base64 is accepted in deployed clients | URL-safe Base64 of the whole SSR payload, no padding in the archived grammar | none                                      | `tryBase64Decode` accepts standard and URL-safe variants            | n/a                                                                           | `EXTENSION` for padded and standard Base64                             | Basic body and IPv6 cases                                   |
| `host`       | unbracketed IPv6 extension                    | Server host                                                                  | none                                      | Splits five fields from the right, so colon-rich hosts survive      | Mihomo accepts a host string                                                  | `OK` for ordinary host; IPv6 is outside the located grammar            | IPv6 asserted                                               |
| `port`       | none                                          | Decimal port                                                                 | none                                      | Frozen baseline uses `parseInt` without an upper bound              | Mihomo target field is an integer                                             | Baseline `PARTIAL`; concurrent strict-port work exists                 | Valid only                                                  |
| `protocol`   | none                                          | SSR authentication protocol name                                             | none                                      | Copied                                                              | Mihomo validates with `PickProtocol`                                          | `OK` for supported values                                              | `auth_chain_a` asserted                                     |
| `method`     | `cipher` in target output                     | SSR cipher                                                                   | none                                      | Copied                                                              | Mihomo allows `none` or a supported stream cipher                             | `OK` for supported values                                              | `aes-256-cfb` asserted                                      |
| `obfs`       | none                                          | SSR obfuscation mode                                                         | none                                      | Copied                                                              | Mihomo validates with `PickObfs`                                              | `OK` for supported values                                              | `tls1.2_ticket_auth` asserted                               |
| `base64pass` | none                                          | URL-safe Base64 UTF-8 password                                               | none                                      | Decodes; if decoding fails, keeps the encoded token as the password | Target consumes the resulting string                                          | `PARTIAL`; malformed encoding changes credentials instead of rejecting | Valid only                                                  |
| `remarks`    | none                                          | URL-safe Base64 display name                                                 | server or `host:port` depending on client | Decodes and uses as name                                            | Metadata only                                                                 | `OK` for valid encoding                                                | Asserted                                                    |
| `obfsparam`  | target `obfs-param`                           | URL-safe Base64 obfs parameter                                               | empty                                     | Decodes; emits an empty string when absent                          | Consumed                                                                      | `OK` for valid encoding                                                | Asserted                                                    |
| `protoparam` | target `protocol-param`                       | URL-safe Base64 protocol parameter                                           | empty                                     | Decodes; emits an empty string when absent                          | Consumed                                                                      | `OK` for valid encoding                                                | Parser reaches it, but the baseline test does not assert it |
| `group`      | none                                          | URL-safe Base64 client grouping label                                        | empty                                     | Ignored                                                             | Mihomo proxy objects have no SSR group field                                  | `TARGET GAP`; drop needs a documented policy                           | Missing                                                     |
| `udpport`    | none                                          | C# client UDP port extension                                                 | client-defined                            | Ignored                                                             | Mihomo SSR has no alternate UDP port field                                    | `TARGET GAP`                                                           | Missing                                                     |
| `uot`        | none                                          | C# client UDP-over-TCP extension                                             | `0` in the archived example               | Ignored                                                             | Mihomo SSR has no UOT field                                                   | `TARGET GAP`                                                           | Missing                                                     |
| absent `/?`  | none                                          | Valid core-only SSR URI                                                      | optional suffix                           | Parses an empty query                                               | Mihomo converter itself requires `/?`, but the archived grammar says optional | `OK`; better than Mihomo's converter                                   | Missing                                                     |

### SSR findings

#### SSR-01: target-unrepresentable optional fields disappear without a policy

Severity candidate: `P3`, raised to `P2` if the product claims lossless import.

`group`, `udpport`, and `uot` are recognized fields in the archived grammar.
The parser drops all three. Mihomo's SSR adapter cannot represent them, so the
parser cannot fix this by copying more YAML keys.

Required guard: choose and document one policy. A strict compatibility mode
should reject non-empty `udpport` or enabled `uot`. A grouping label may remain
import metadata if the application has an explicit field for it. Unknown target
keys are not a valid preservation mechanism because Mihomo ignores them.

#### SSR-02: malformed Base64 parameters can become credentials

Severity candidate: `P2`.

The required password must be URL-safe Base64. The parser falls back to the raw
encoded token when decoding fails. A malformed share therefore survives with a
different password and fails later as an authentication problem.

Required guard: reject an invalid required password encoding. For optional
Base64 fields, distinguish absent from present-but-invalid and reject the latter.

### SSR test gaps

- A direct assertion for `protocol-param`.
- Core-only URI with no `/?` suffix.
- `group`, `udpport`, and `uot`, including the chosen target-gap policy.
- URL-safe no-padding input, padded input compatibility, and invalid Base64.
- Invalid protocol, cipher, and obfs values through fixed Mihomo validation.
- Cipher `none`, which Mihomo maps to its compatibility dummy cipher.
- Strict port boundaries and bracketed versus unbracketed IPv6 policy.

## VMess

### Two distinct share formats

| Property                | v2rayN Base64 JSON                                               | Xray VMess AEAD URL                                                     |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Outer shape             | `vmess://BASE64(JSON)`                                           | `vmess://uuid@host:port?query#tag`                                      |
| Authority               | v2rayN wiki and deployed clients, `E5`                           | Xray Discussion #716, mutable `E2` proposal                             |
| Authentication selector | `aid` or client alias `alterId`; zero selects AEAD in v2ray-core | No `aid` or `alterId` field exists in the proposal                      |
| VMess body cipher       | JSON `scy`, default `auto`                                       | Query `encryption`, default `auto`                                      |
| Transport               | JSON `net`, `type`, `host`, `path`                               | Query `type` and transport-specific keys                                |
| TLS                     | JSON `tls`, `sni`, `alpn`, plus newer client fields              | Query `security`, `fp`, `sni`, `alpn`, `pcs`, `vcn`, and related fields |
| Frozen parser           | Parses JSON only                                                 | Rejects as invalid VMess Base64                                         |
| Mihomo converter        | Parses it                                                        | Parses it after Base64 decode fails                                     |

### Modern VMess AEAD URL matrix

The Xray proposal makes parameter names and constants case-sensitive, forbids
duplicate fields, requires URI encoding for values, and requires a port in
`1..65535`.

| Raw location or key         | Aliases                                | Semantic and type                                                     | Proposal default                  | Mihomo conversion                                                                             | Frozen parser | Status                                                          |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| Userinfo `uuid`             | none                                   | Non-empty UUID                                                        | none                              | Maps to `uuid`                                                                                | Never reached | `REJECT`                                                        |
| `host` and `port` authority | bracketed IPv6                         | Server endpoint                                                       | none                              | Maps to server and port                                                                       | Never reached | `REJECT`                                                        |
| `#descriptive-text`         | none                                   | Percent-encoded node name                                             | generated name when absent        | Maps to name                                                                                  | Never reached | `REJECT`                                                        |
| `encryption`                | none                                   | VMess body cipher: `auto`, `aes-128-gcm`, `chacha20-poly1305`, `none` | `auto`; explicit empty is invalid | Maps to `cipher`, sets `alterId: 0`                                                           | Never reached | `REJECT`                                                        |
| `alterId`, `aid`            | none                                   | Explicitly absent from this format                                    | n/a                               | Mihomo hard-codes zero                                                                        | Never reached | Correct future behavior must reject these keys                  |
| `type`                      | none                                   | `tcp`, `kcp`, `ws`, `http`, `grpc`, `httpupgrade`, or `xhttp`         | `tcp` in Mihomo helper            | Maps to target transport; `http` becomes H2                                                   | Never reached | `REJECT`                                                        |
| `headerType`                | none                                   | Fake header for transports such as TCP and KCP                        | transport-defined                 | Mihomo maps TCP plus `http` to target `http`                                                  | Never reached | `REJECT`                                                        |
| `host`, `path`              | none                                   | Transport host and path                                               | transport-defined                 | Maps for HTTP, H2, WS, HTTPUpgrade, and XHTTP                                                 | Never reached | `REJECT`                                                        |
| `serviceName`               | none                                   | gRPC service                                                          | non-empty recommended             | Maps to gRPC options                                                                          | Never reached | `REJECT`                                                        |
| `mode`, `authority`         | none                                   | gRPC or XHTTP submode and gRPC authority                              | mode defaults depend on transport | Mihomo helper maps XHTTP mode but not gRPC mode/authority                                     | Never reached | `REJECT`; target mapping is also partial                        |
| `mtu`, `tti`                | none                                   | mKCP integer settings                                                 | Xray-core default                 | Current Mihomo helper does not map these URL keys                                             | Never reached | `REJECT`; Mihomo's VMess YAML can represent them in `mkcp-opts` |
| `extra`                     | none                                   | Percent-encoded XHTTP JSON settings                                   | absent                            | Mihomo maps a supported subset to `xhttp-opts`                                                | Never reached | `REJECT`                                                        |
| `fm`                        | none                                   | Percent-encoded Finalmask JSON                                        | absent                            | Current Mihomo converter and VMess adapter have no equivalent field                           | Never reached | `REJECT` and likely `TARGET GAP`                                |
| `security`                  | none                                   | `none`, `tls`, or `reality`                                           | `none`; explicit empty is invalid | Enables TLS or Reality fields                                                                 | Never reached | `REJECT`                                                        |
| `fp`                        | none                                   | TLS ClientHello fingerprint                                           | `chrome`; required for Reality    | Maps to `client-fingerprint`                                                                  | Never reached | `REJECT`                                                        |
| `sni`                       | none                                   | TLS or Reality server name                                            | remote host                       | Maps to `servername`                                                                          | Never reached | `REJECT`                                                        |
| `alpn`                      | none                                   | Comma-separated ALPN list                                             | core default                      | Maps to array                                                                                 | Never reached | `REJECT`                                                        |
| `ech`                       | none                                   | Percent-encoded ECH configuration list                                | empty is allowed                  | Current Mihomo share helper does not map it; target VMess has `ech-opts`                      | Never reached | `REJECT`; exact target translation needs evidence               |
| `pcs`                       | none                                   | Comma-separated certificate SHA-256 pins in Xray                      | empty                             | Mihomo helper maps to `fingerprint`, which has related but not identical documented semantics | Never reached | `REJECT`; translation needs a compatibility decision            |
| `vcn`                       | none                                   | Certificate verification names in Xray                                | empty                             | Mihomo helper does not map it                                                                 | Never reached | `REJECT`; likely `TARGET GAP` when separate from SNI            |
| `pbk`, `sid`                | none                                   | Reality public key and short ID                                       | required/optional under Reality   | Maps to `reality-opts`                                                                        | Never reached | `REJECT`                                                        |
| `pqv`, `spx`                | none                                   | Reality ML-DSA-65 verification key and spider path                    | empty                             | Mihomo `v1.19.28` Reality options have no matching fields                                     | Never reached | `REJECT` and `TARGET GAP`                                       |
| `ed`, `eh`                  | path-carried `ed` in deployed WS links | WebSocket early data size and header                                  | absent                            | Mihomo helper maps both                                                                       | Never reached | `REJECT`                                                        |

### Legacy Base64 JSON field matrix

The v2rayN wiki example writes every shown scalar as a JSON string. Mihomo and
Sub-Store accept some numeric and Boolean variations, but neither source turns
arbitrary arrays or objects into valid scalar values.

| Raw JSON key              | Aliases in fixed clients/converters                      | Canonical semantic and expected type                                | Default                                            | Frozen parser output                                                             | Status                                                                          | Baseline assertion                                                   |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `v`                       | none                                                     | Share schema version string                                         | client-defined                                     | Ignored                                                                          | `OK` as metadata                                                                | Fixture includes it, no direct assertion                             |
| `ps`                      | `remarks`, `remark` in Sub-Store                         | Display name string                                                 | `server:port`                                      | Only `ps` is read                                                                | `PARTIAL`                                                                       | `ps` asserted                                                        |
| `add`                     | none                                                     | Server domain or IP string                                          | none                                               | `String(value)`, brackets removed                                                | `PARTIAL`; objects become `[object Object]`                                     | Valid string only                                                    |
| `port`                    | none                                                     | Decimal string or integer compatibility form, `1..65535`            | none                                               | `String` then frozen `parseInt`                                                  | Baseline `PARTIAL`; concurrent strict-port work covers the shared numeric guard | String only                                                          |
| `id`                      | none                                                     | UUID string                                                         | none                                               | `String(value)` with no parser-level validation                                  | `PARTIAL`; Mihomo validates later                                               | String only                                                          |
| `aid`                     | `alterId` in Sub-Store                                   | Non-negative integer selector                                       | frozen parser and Mihomo converter default to zero | Only `aid` is read; invalid parse becomes zero                                   | `PARTIAL`, unsafe fallback on wrong type                                        | String zero only                                                     |
| `scy`                     | none                                                     | `auto`, `none`, `zero`, `aes-128-gcm`, or `chacha20-poly1305`       | `auto`                                             | Any string is copied; absent becomes auto                                        | `PARTIAL`; Mihomo rejects unsupported values later                              | `auto` only                                                          |
| `net`                     | `obfs=websocket` in Shadowrocket/Sub-Store               | Transport string                                                    | `tcp`                                              | Lowercases any string and emits it as `network`                                  | `PARTIAL`; unknown values reach Mihomo's TCP fallback                           | WS, H2, gRPC, HTTPUpgrade, and TCP are reached across baseline tests |
| `type`                    | none                                                     | Fake header type for TCP/KCP/QUIC; `http` is meaningful for TCP     | `none`                                             | Ignored                                                                          | `DROP`                                                                          | Missing                                                              |
| `host`                    | `obfsParam` in Shadowrocket/Sub-Store                    | Transport host string; comma-list rules vary by transport           | absent                                             | Used for WS/H2 only                                                              | `PARTIAL`                                                                       | WS only                                                              |
| `path`                    | none                                                     | WS/H2 path, gRPC service, KCP seed, or QUIC key                     | transport-specific                                 | Used for WS/H2/gRPC only                                                         | `PARTIAL`                                                                       | WS and early data asserted                                           |
| `authority`               | none                                                     | gRPC authority                                                      | empty                                              | Ignored                                                                          | `DROP`                                                                          | Missing                                                              |
| `ed`                      | path query `ed`                                          | Top-level early-data extension                                      | absent                                             | Only path-carried `ed` is read                                                   | `PARTIAL`                                                                       | Path form only                                                       |
| `tls`                     | none                                                     | v2rayN string `tls`; Boolean `true` and `1` are deployed extensions | no TLS                                             | After stringification, `tls`, `true`, or `1` enable TLS                          | `PARTIAL`; objects disable TLS without error                                    | String and Boolean true asserted                                     |
| `sni`                     | `peer` in Sub-Store                                      | TLS server name string                                              | server                                             | Maps to Mihomo `servername`, only when TLS is enabled                            | `OK` for `sni`                                                                  | Asserted                                                             |
| `alpn`                    | none                                                     | Comma-separated ALPN string                                         | target default                                     | Splits to an array, only when TLS is enabled                                     | `OK` for a string                                                               | Fixture reaches it; no focused edge assertion                        |
| `fp`                      | none                                                     | ClientHello fingerprint string                                      | client-defined                                     | Ignored                                                                          | `DROP`                                                                          | Missing                                                              |
| `insecure`                | `allowInsecure`, inverse `verify_cert` in Sub-Store      | Certificate verification policy                                     | verify                                             | Ignored                                                                          | `DROP`; usually causes stricter failure rather than downgrade                   | Missing                                                              |
| `vcn`                     | none                                                     | Xray certificate verification names                                 | empty                                              | Ignored                                                                          | `DROP` and possible `TARGET GAP`                                                | Missing                                                              |
| `pcs`                     | none                                                     | Certificate SHA-256 pin string                                      | empty                                              | Ignored                                                                          | `DROP`; removes an explicit authentication constraint                           | Missing                                                              |
| fragment outside Base64   | none                                                     | Some clients use an outer name override                             | internal `ps`                                      | Frozen parser includes `#` in its Base64 body; the Base64 shape check rejects it | `REJECT`; Sub-Store supports an outer fragment                                  | Missing                                                              |
| Shadowrocket query format | `remarks`, `obfs`, `obfsParam`, `peer`, and related keys | Alternate VMess URI family                                          | none                                               | Rejected because JSON decode is mandatory                                        | `REJECT`; client extension                                                      | Missing                                                              |

### Legacy transport mapping

| Input combination      | Intended semantic from fixed evidence                         | Frozen parser result            | Mihomo runtime result                      | Status                     |
| ---------------------- | ------------------------------------------------------------- | ------------------------------- | ------------------------------------------ | -------------------------- |
| `net=tcp`, `type=none` | Raw TCP                                                       | `network: tcp`                  | TCP                                        | `OK`                       |
| `net=tcp`, `type=http` | Fake HTTP header transport                                    | `network: tcp`, no `http-opts`  | Raw TCP                                    | `DROP`                     |
| `net=http`             | Legacy H2 spelling in Mihomo and Sub-Store converters         | `network: http`, no `http-opts` | HTTP header transport with target defaults | Wrong transport            |
| `net=h2`               | H2 with host list and path                                    | `network: h2`, `h2-opts`        | H2                                         | `OK` for basic fields      |
| `net=ws`               | WebSocket with host/path and optional early data              | `network: ws`, `ws-opts`        | WebSocket                                  | `OK` for covered fields    |
| `net=httpupgrade`      | HTTPUpgrade represented by Mihomo's WS option flags           | `network: ws`, upgrade flag     | HTTPUpgrade compatibility path             | `EXTENSION`, covered       |
| `net=grpc`             | gRPC, path as service; type/mode and authority may matter     | gRPC service only               | gRPC without imported mode/authority       | `PARTIAL`                  |
| `net=kcp`              | mKCP, with `type` header and `path` seed in the v2rayN format | `network: kcp`, no `mkcp-opts`  | mKCP with target defaults                  | `DROP` for header and seed |
| `net=quic`             | QUIC with security/key/header fields                          | `network: quic`                 | Mihomo VMess falls through to ordinary TCP | `FALLBACK`                 |
| unknown `net`          | Invalid or unsupported transport                              | Unknown value copied            | Mihomo VMess falls through to ordinary TCP | `FALLBACK`                 |

### Scalar type policy

`const get = (k) => json[k] != null ? String(json[k]) : ''` erases the JSON
type of every field. A safer compatibility policy would be:

| Semantic                                                                         | Accepted input types                                                                          | Rejected input types                                            | Reason                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Names, server, UUID, cipher, transport, host, path, SNI, ALPN, fingerprint, pins | JSON string                                                                                   | Boolean, object, array, null when required                      | These fields are text in the v2rayN contract and target structs         |
| Port                                                                             | Decimal string or integer                                                                     | Float, Boolean, object, array, sign, suffix, outside `1..65535` | Preserve common string/integer emitters without numeric-prefix mutation |
| Alter ID                                                                         | Decimal string or non-negative integer                                                        | Float, Boolean, object, array, negative, overflow               | Zero and nonzero select different VMess authentication paths            |
| TLS enable                                                                       | String `tls`, optionally Boolean true/false and numeric 1/0 as named compatibility extensions | Object, array, other numbers, unknown strings                   | Fail closed when an untrusted source gives the wrong type               |
| Insecure flag                                                                    | String or Boolean only under a defined alias policy                                           | Object, array, unknown string                                   | Avoid accidental verification changes                                   |

The parser must validate the type before coercion. Compatibility aliases should
remain explicit branches with tests.

### VMess findings

#### VM-01: all modern VMess AEAD URL shares are rejected

Severity candidate: `P2` compatibility.

Synthetic input:

```text
vmess://11111111-1111-4111-8111-111111111111@edge.example:443?type=ws&security=tls&host=cdn.example&path=%2Fws#Modern
```

The frozen parser tries to Base64-decode the entire body and returns
`invalid vmess base64`. Mihomo's fixed converter handles the same outer shape
by parsing it as a URL, setting `alterId: 0`, defaulting the body cipher to
`auto`, and calling its shared VMess/VLESS URL mapper.

Required change: dispatch by syntax. A body with a valid URL authority should
use a strict VMess AEAD URL parser. A Base64 body should continue to use the
legacy JSON parser. Do not make arbitrary Base64 failure the only discriminator
because malformed JSON must still produce a JSON-specific error.

#### VM-02: unsupported and unknown transports fall back to TCP

Severity candidate: `P1` when a transport carries TLS or authentication
semantics, otherwise `P2`.

The frozen parser copies any `net` value to `network`. Mihomo's VMess adapter
handles WS, HTTP, H2, gRPC, Mekya, and mKCP explicitly. Its default branch uses
TCP. A synthetic `net=quic` node passes `mihomo -t` and then uses the default TCP
branch. The same fallback applies to a typo such as `net=wss`.

The parser also ignores `type=http` on TCP, drops KCP seed/header fields, and
maps the deployed `net=http` H2 spelling to Mihomo HTTP rather than H2.

Required guard: use a closed transport table. Map every supported raw form to
one target semantic with the required nested options. Reject QUIC and unknown
values because Mihomo `v1.19.28` cannot represent them for VMess.

#### VM-03: certificate pinning and TLS client identity fields are dropped

Severity candidate: `P1` for `pcs`, `P2` for the remaining compatibility loss.

The v2rayN wiki currently documents `fp`, `insecure`, `vcn`, and `pcs`. The
frozen parser imports none of them. Mihomo VMess supports
`client-fingerprint`, `skip-cert-verify`, `fingerprint`, and `servername`.

Dropping `pcs` removes an explicit certificate authentication constraint.
Mapping it to Mihomo `fingerprint` still needs review because Xray describes a
comma-separated pinned-peer field while Mihomo documents certificate
fingerprint and chain behavior. `vcn` can differ from SNI and has no clear
separate Mihomo field.

Required guard: map fields only after their target semantics are proven. Reject
a non-empty `pcs` or `vcn` when exact preservation is impossible. Do not accept
the node after silently removing a pin or verification name.

#### VM-04: scalar coercion can disable TLS and switch authentication mode

Severity candidate: `P1` fail-closed validation.

This synthetic JSON is malformed by the v2rayN contract but accepted:

```json
{
  "ps": "Scalars",
  "add": "edge.example",
  "port": "443",
  "id": "11111111-1111-4111-8111-111111111111",
  "aid": true,
  "scy": "auto",
  "net": "tcp",
  "tls": { "enabled": true }
}
```

The frozen parser emits `alterId: 0` and no `tls` field. `aid=true` becomes
`NaN` and then zero. The object-valued TLS field becomes `[object Object]`,
which does not match the three enabled strings.

Required guard: validate JSON types first. If a TLS field is present with an
unsupported type or value, reject the node. If `aid` is present but is not a
non-negative integer, reject it instead of selecting AEAD.

#### VM-05: legacy fake HTTP and mKCP parameters are lost

Severity candidate: `P2`.

The v2rayN contract assigns transport meaning to `type`, `host`, and `path`.
For TCP, `type=http` selects fake HTTP. For KCP, `type` is the header and `path`
is the seed. The frozen parser ignores `type` and does not build `mkcp-opts`.

Required mapping for Mihomo:

- TCP plus `type=http` -> `network: http` with validated `http-opts`.
- `net=http` compatibility alias -> `network: h2` with `h2-opts`.
- KCP -> target `network: mkcp` or its accepted alias, with `mkcp-opts.header`
  and `mkcp-opts.seed` after target validation.
- QUIC -> rejection for this target.

#### VM-06: parser defaults do not record the VMess UDP encoding decision

Severity: `UNRESOLVED`.

The frozen parser emits `udp: true` but no packet encoding field. Mihomo's own
legacy VMess share converter emits `xudp: true`. Meta-Docs say an empty
`packet-encoding` means raw. Sub-Store's fixed parser does not set XUDP in the
same legacy JSON branch.

The evidence does not establish one cross-client default. Integration should
keep raw, packetaddr, and XUDP distinct and add a fixed binary interoperability
test before changing this default.

### VMess AEAD and deprecation boundary

| Source               | Boundary                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Xray share proposal  | URL-form VMess is AEAD-only and has no `aid` or `alterId`.                                                                                      |
| Xray-core `v26.3.27` | VMess account configuration has no alter ID and emits a warning that VMess lacks forward secrecy. The warning points users to VLESS Encryption. |
| v2ray-core `v5.51.2` | `alterId` remains a typed field. Zero creates an AEAD client session; nonzero retains the legacy authentication path.                           |
| v2fly protocol docs  | The MD5 header authentication method is deprecated. The core can still negotiate AEAD or MD5.                                                   |
| Mihomo `v1.19.28`    | `alterId` remains required in the documented VMess proxy shape; nonzero enables legacy protocol behavior.                                       |

Parser policy must preserve a valid nonzero legacy `aid` in the Base64 JSON
format. The modern URL parser must set zero and reject `aid` or `alterId` query
keys. Product UI may warn about VMess and legacy authentication, but an importer
must not rewrite the authentication mode.

### VMess test gaps

- Modern VMess AEAD URL for TCP, WS, H2, gRPC, HTTPUpgrade, mKCP, and XHTTP.
- Modern URL defaults, explicit empty values, duplicate query fields,
  case-sensitive constants, bracketed IPv6, and port bounds.
- Legacy aliases `remarks`, `remark`, `alterId`, `peer`, `obfs`, and
  `obfsParam`, if the product chooses to support them.
- `net=tcp&type=http`, the `net=http` H2 alias, KCP seed/header, QUIC rejection,
  and an unknown transport rejection.
- gRPC mode and authority policy.
- `fp`, `insecure`, `allowInsecure`, `verify_cert`, `pcs`, and `vcn`, including
  target-unrepresentable rejection paths.
- Scalar matrix for every required field: string, integer compatibility,
  Boolean, null, array, object, float, negative, overflow, and numeric suffix.
- `aid=0` and nonzero through fixed v2ray-core or Mihomo behavior; malformed
  `aid` must not become zero.
- All supported ciphers plus unknown cipher diagnostics.
- Outer fragment precedence for legacy Base64 JSON.
- UDP packet encoding default after the unresolved target decision.

## Reproduction record

All inputs below use reserved example domains, a synthetic UUID, and the literal
password `synthetic-password`.

### Frozen parser outputs

The following results came from the extracted baseline file, not concurrent
worktree code:

| Case                     | Synthetic input feature                           | Observed output                                                       |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| SS escaped option        | `path=/socket\\;matrix=1`                         | Path becomes `/socket\\`; `matrix=1` is detached                      |
| SS mux disable           | `plugin=v2ray-plugin;host=cdn.example;mux=0`      | `plugin-opts.mux` is absent; Mihomo defaults it to true               |
| SS unknown plugin        | `plugin=future-plugin;mode=tls`                   | Node succeeds with no `plugin` field                                  |
| SS wrapper               | `security=tls&type=ws`                            | Intermediate object contains TLS and WS fields that Mihomo SS ignores |
| VMess AEAD URL           | Ordinary `uuid@host:port` URL                     | No proxy; `invalid vmess base64`                                      |
| VMess fake HTTP          | JSON `net=tcp,type=http`                          | `network: tcp`, no `http-opts`                                        |
| VMess KCP                | JSON `net=kcp,type=wireguard,path=synthetic-seed` | `network: kcp`, no `mkcp-opts`                                        |
| VMess QUIC               | JSON `net=quic`                                   | `network: quic`; fixed Mihomo source falls back to TCP                |
| VMess TLS controls       | JSON with `fp`, `insecure`, `vcn`, and `pcs`      | Only TLS, SNI, and ALPN survive                                       |
| VMess wrong scalar types | Boolean `aid`, object `tls`                       | `alterId: 0`, TLS absent, no error                                    |

### Fixed Mihomo binary

Binary record:

```text
Asset: mihomo-darwin-arm64-v1.19.28.gz
Asset SHA-256: 40cdae2fab4b18df15f40eaa9dc3af70ab3d8be7f77164ae1e5f1af3a2a4fb44
Binary SHA-256: 55b7286331cb30a54b2564013b02b84a0c280e8b690bd1e5da4b9d4f4ca007ac
Version: Mihomo Meta v1.19.28 darwin arm64 with go1.26.5 Wed Jul 8 00:22:34 UTC 2026
```

Two full synthetic configurations passed `mihomo -t -f <file>`:

1. SS with top-level `tls`, `sni`, `network: ws`, and `ws-opts` but no plugin.
2. VMess with `network: quic`.

Source at the same release resolves the ambiguity. The SS fields are absent
from `ShadowSocksOption`; the unknown VMess network reaches the TCP default
branch. A successful configuration test does not prove that requested transport
semantics execute.

## Implementation status — 2026-07-15

The high-confidence P1/P2 subset from this workstream is now implemented in the
shared parser and its URI regression suite:

- SS rejects top-level TLS/Reality/transport wrappers that Mihomo's SS outbound
  would ignore; unknown plugins and unrepresentable plugin modes/options also
  fail closed.
- SIP003 plugin parsing now honors escaped semicolons, equal signs, and
  backslashes. Supported obfs, v2ray-plugin, and shadow-tls mappings remain.
  Explicit v2ray-plugin `mux=0` becomes `mux: false`; non-Boolean concurrency
  and non-WebSocket mode reject.
- Shadowrocket shadow-tls payloads require canonical Base64/UTF-8 JSON, an
  object shape, a host, version 1/2/3 when present, and a valid replacement
  endpoint port.
- SSR required and optional encoded fields fail closed on malformed Base64.
  `group` is validated then intentionally ignored as metadata; non-empty
  `udpport` and `uot` reject because Mihomo has no matching SSR target field.
- Legacy VMess JSON validates raw field types, preserves only nonnegative safe
  integer `aid`, uses a closed TLS scalar set, maps fake HTTP/H2/mKCP, rejects
  QUIC and unknown transports, maps documented `fp`/`insecure`, and rejects
  non-empty `pcs`/`vcn`.
- The shared Base64 helper now enforces standard/base64url canonical round-trip,
  exact optional padding, and fatal UTF-8 while retaining legal missing padding
  and folded whitespace.
- Adjacent XHTTP safety follow-ups accept nested Reality `pbk`/`sid` aliases and
  reject the Xray-invalid `stream-one` plus `downloadSettings` combination.
- Explicit VLESS `packetEncoding=none` now rejects because the current emitter
  cannot represent raw mode: omitting the target key would select XUDP instead.

Test-first record:

- Before the SS/SSR/VMess implementation, the expanded targeted file reported
  `45 failed | 111 passed` (`156` total).
- After that implementation it reported `156 passed`.
- The two XHTTP follow-ups failed before their fix, and the Base64 helper suite
  exposed eight old-logic failures before its fix.
- Final targeted result: `167 passed`; subscription blast result: `222 passed`
  across eight files; full Vitest result: `617 passed` across 47 files.
  Typecheck, targeted ESLint, Prettier check, and `git diff --check` passed.
- The generated VLESS security/transport full config passed fixed Mihomo
  `v1.19.28`. The generated all-family config stopped at an unrelated existing
  WireGuard synthetic private-key Base64 error, so that run is not recorded as
  an all-family pass.
- The WireGuard fixture was subsequently corrected; the final 6/6 fixed-Mihomo
  result is recorded in `../validation.md`.

Modern VMess AEAD URL parsing remains intentionally unimplemented. VMess UDP
packet encoding remains unresolved as documented in VM-06.

## Proposed implementation and test ownership

The table below is the audit-phase proposal. The status section above records
the subset integrated in this pass; modern VMess AEAD URL support remains a
follow-up, while the completed fixed-binary matrix is recorded in
`../validation.md`. Shared parser and test-file ownership must
still be serialized between agents.

| Order | Proposed change                                                                    | Proposed source                                       | Proposed tests                                                             |
| ----- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| 1     | Add strict scalar and closed-enum helpers before protocol changes                  | `web/lib/proxies/uriToClash.ts`                       | `web/tests/subscriptions/proxyUri.test.ts`                                 |
| 2     | Replace the SS plugin split with a SIP003 escape-aware tokenizer                   | same                                                  | Escapes, unsupported plugin, modes, aliases, and mux disable               |
| 3     | Reject SS top-level wrapper semantics that cannot become a supported Mihomo plugin | same                                                  | Parser rejection and fixed Mihomo end-to-end check                         |
| 4     | Split VMess dispatch into Base64 JSON and modern AEAD URL parsers                  | same                                                  | Both format families and syntax-specific errors                            |
| 5     | Add a target-aware legacy VMess transport table                                    | same                                                  | Fake HTTP, H2 alias, WS, HTTPUpgrade, gRPC, mKCP, QUIC, and unknown values |
| 6     | Map or reject VMess TLS identity and certificate controls                          | same                                                  | `fp`, pins, verification names, and insecure aliases                       |
| 7     | Make SSR target-gap and invalid Base64 policy explicit                             | same                                                  | `group`, `udpport`, `uot`, missing suffix, and invalid encodings           |
| 8     | Run generated proxy objects through a checksum-pinned Mihomo full-config fixture   | audit validation harness or targeted integration test | Assert executed target shape, not only the intermediate JavaScript object  |

## Questions for integration

1. Does ProxyManager promise to import Shadowrocket SS/VMess extensions, or
   should it reject any nonstandard wrapper that cannot map exactly to Mihomo?
2. Should non-empty SSR `udpport` and enabled `uot` reject import, or should the
   UI preserve them as non-rendered metadata?
3. Is v2rayN's `pcs` compatible enough with Mihomo `fingerprint` to translate?
   The current docs describe different field shapes and verification behavior.
4. How should `vcn` behave when it differs from SNI? The inspected Mihomo VMess
   option exposes one `servername` and no separate verification-name list.
5. Which VMess UDP packet encoding should an omitted legacy JSON field select?
   Mihomo's converter and Sub-Store differ.
6. Should modern Xray Discussion #716 be treated as a supported contract now,
   or an opt-in compatibility format? It is mutable rather than tag-pinned.
7. Should whole-payload SS Base64 and padded SSR Base64 remain compatibility
   inputs after strict validation? Both are deployed, but only the former is
   documented by shadowsocks-org and neither is the preferred current form.

## Self-review

- Every high-risk claim has fixed source or binary evidence.
- SIP002/SIP003 rules are kept separate from client extensions.
- SSR lifecycle language does not claim global deprecation.
- VMess protocol deprecation, MD5 authentication deprecation, and AEAD URL
  format are treated as separate facts.
- All reproduction values are synthetic and contain no real credentials.
- The audit phase changed only this workstream document; the serialized
  implementation phase changed the shared parser and its URI regression tests.
