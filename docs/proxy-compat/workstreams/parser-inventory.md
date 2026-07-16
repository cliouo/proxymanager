# URI parser code inventory (phase-0 baseline)

## Scope and snapshot

This is a read-only inventory of the URI parser and its immediate delivery path. It is frozen at the clean phase-0 baseline commit:

- commit: `9596cec88fb17fd67ed7102b625b18bb92e9f68f`
- primary parser: `web/lib/proxies/uriToClash.ts`
- normaliser/delivery entry: `web/lib/services/subscriptionFetcher.ts`
- direct parser tests: `web/tests/subscriptions/proxyUri.test.ts`
- normaliser tests: `web/tests/subscriptions/fetcher.test.ts`
- object/string delivery equivalence tests: `web/tests/subscriptions/objectPipeline.test.ts`

`web/AGENTS.md` and `web/CLAUDE.md` were read in full before this inventory. `CLAUDE.md` delegates to `AGENTS.md`; the relevant rule is that this checkout's Next.js version must be treated as project-specific and its bundled docs consulted before Next.js code changes. No source or test file was changed by this workstream.

While this inventory was being written, the integration worktree acquired concurrent changes in `uriToClash.ts`, `subscriptionFetcher.ts`, and `proxyUri.test.ts`. Per coordinator direction, those edits are not folded into the initial counts below. The two identified in-progress remediations are recorded separately under [Concurrent audit changes](#concurrent-audit-changes).

## Counting method and exact code-derived counts

The counts in this section describe what the baseline code statically names. They are not yet a standards-complete parameter matrix.

| Item                                               | Exact baseline count | Method                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered URI schemes                             |                   17 | Literal members of `KNOWN_SCHEMES` at `uriToClash.ts:33-51`; identical key set in `PARSERS` at `1058-1076`.                                                                                                                                                                |
| Independent parser families                        |                   13 | Distinct parser functions referenced by `PARSERS`; multiple schemes sharing one function count once.                                                                                                                                                                       |
| Secondary scheme spellings                         |                    4 | `hy2`, `wg`, `socks`, and `https`; each shares a parser with a canonical family. `https` additionally causes `tls: true`.                                                                                                                                                  |
| Static top-level named raw-field occurrences       |                  127 | Sum of protocol-local query/JSON keys listed below. A key used by two protocols counts twice. URI structural locations (userinfo, host, port, fragment) are excluded.                                                                                                      |
| Unique static top-level raw spellings              |                   73 | Deduplicate those 127 exact spellings across protocols, preserving case, hyphen, and underscore differences.                                                                                                                                                               |
| Static nested raw leaf occurrences                 |                   60 | 15 SS path/plugin/shadow-TLS leaves plus 45 VLESS XHTTP `extra` dotted leaf paths. Repeated leaves at different dotted locations count separately.                                                                                                                         |
| Unique static raw spellings, top-level plus nested |                  108 | Deduplicate the 73 top-level spellings and all nested leaf names. This deliberately does not collapse aliases.                                                                                                                                                             |
| Static, named top-level output fields              |                   56 | Union of fields the 13 parser families can emit, excluding the dynamic AnyTLS/WireGuard addon placeholder. Base fields `name`, `type`, `server`, `port` are included.                                                                                                      |
| Runtime-accepted raw names                         |            Unbounded | AnyTLS (`933-965`) and WireGuard (`968-1010`) pass through arbitrary non-empty query keys after `_` to `-` normalisation. Therefore an exact finite count of every accepted raw name or alias is impossible unless wildcard passthrough is represented as one matrix rule. |

Important counting boundaries:

1. A structural parameter such as VLESS userinfo UUID or URI fragment name needs a matrix row, but it is not a _named query/JSON key_, so it is not in the 127 count.
2. `AnyTLS.*` and `WireGuard.*` wildcard passthrough must be represented as explicit wildcard rows. Inventing a finite raw-key total from observed fixtures would undercount actual behavior.
3. Output fields are not the same as canonical semantics. For example, `sni` and `servername` may represent a related semantic for different target types, while `ws-opts.headers.Host` is nested target syntax.
4. Alias counts must state whether wildcard `_` to `-` normalisation is excluded. The baseline has 20 finite, location-sensitive raw equivalence groups documented below, plus two wildcard normalisation rules (AnyTLS and WireGuard); those wildcard rules make the runtime alias set unbounded.

Static top-level occurrence subtotal by family:

| Family     | Count | Included carrier                                                                              |
| ---------- | ----: | --------------------------------------------------------------------------------------------- |
| SS         |    20 | query                                                                                         |
| SSR        |     3 | query; positional payload fields excluded from this subtotal                                  |
| VMess      |    12 | base64 JSON                                                                                   |
| VLESS      |    20 | query; nested `extra` excluded from this subtotal                                             |
| Trojan     |    10 | query                                                                                         |
| Hysteria 1 |    12 | query                                                                                         |
| Hysteria 2 |    14 | query                                                                                         |
| TUIC       |     7 | query                                                                                         |
| Snell      |     3 | query                                                                                         |
| AnyTLS     |    11 | six direct keys plus five additional typed passthrough keys; wildcard remains unbounded       |
| WireGuard  |    15 | ten special spellings plus five additional typed passthrough keys; wildcard remains unbounded |
| SOCKS      |     0 | structural URL fields only                                                                    |
| HTTP(S)    |     0 | structural URL fields only; query is accepted by `URL` but not read                           |

## Registry

Baseline anchors: `uriToClash.ts:32-51`, `53-62`, `90-118`, and `1058-1076`.

| Canonical family | Registered schemes | Parser function  | Output `type` | Notes                                                            |
| ---------------- | ------------------ | ---------------- | ------------- | ---------------------------------------------------------------- |
| Shadowsocks      | `ss`               | `parseSS`        | `ss`          | Three wire forms share one parser.                               |
| ShadowsocksR     | `ssr`              | `parseSSR`       | `ssr`         | Whole body is base64.                                            |
| VMess            | `vmess`            | `parseVMess`     | `vmess`       | V2RayN-style base64 JSON only.                                   |
| VLESS            | `vless`            | `parseVLESS`     | `vless`       | Includes transport, Reality, packet encoding, and XHTTP mapping. |
| Trojan           | `trojan`           | `parseTrojan`    | `trojan`      | Defaults port to 443.                                            |
| Hysteria 1       | `hysteria`         | `parseHysteria`  | `hysteria`    | Registered but has no direct parser test in the baseline suite.  |
| Hysteria 2       | `hysteria2`, `hy2` | `parseHysteria2` | `hysteria2`   | Hand-parsed to permit port sets.                                 |
| TUIC             | `tuic`             | `parseTUIC`      | `tuic`        | URL userinfo is UUID/password.                                   |
| Snell            | `snell`            | `parseSnell`     | `snell`       | URL username is PSK.                                             |
| AnyTLS           | `anytls`           | `parseAnyTLS`    | `anytls`      | Arbitrary addon passthrough.                                     |
| WireGuard        | `wireguard`, `wg`  | `parseWireGuard` | `wireguard`   | Arbitrary addon passthrough; `wg` is normalised before `URL`.    |
| SOCKS            | `socks`, `socks5`  | `parseSocks`     | `socks5`      | Plain or base64 username carrier.                                |
| HTTP proxy       | `http`, `https`    | `parseHttp`      | `http`        | `https` sets `tls: true`; explicit port required.                |

`SCHEME_REGEX` and `parseProxyUriList` lowercase the scheme for dispatch (`32`, `98-102`), so registry lookup is case-insensitive. Query-key handling is not globally case-insensitive.

## Shared parsing behavior and helpers

| Helper / locus              | Baseline lines | Behavior relevant to the matrix                                                                                                                                                                                  |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `looksLikeProxyUriList`     | `53-62`        | Ignores blank lines and lines starting with `#` or `//`; recognises only `KNOWN_SCHEMES`.                                                                                                                        |
| `tryBase64Decode`           | `64-84`        | Removes all whitespace, accepts standard/URL-safe alphabet and missing padding, rejects fewer than four encoded characters and decoded control bytes. It does not prove canonical base64 encoding.               |
| `parseProxyUriList`         | `90-118`       | Parses recognised scheme lines, skips non-URI text, accumulates per-line errors, and makes names unique with ` #2`, ` #3`, etc.                                                                                  |
| `splitTag`                  | `1082-1086`    | SS-only fragment split; first `#` wins and the fragment is percent-decoded once.                                                                                                                                 |
| `parseQueryString`          | `1088-1099`    | Manual `&`/first-`=` split; percent-decodes key and value; later duplicate keys overwrite earlier keys; literal `+` is preserved. Used by SS, SSR, Hysteria 2, and WS path `ed`.                                 |
| `paramsToRecord`            | `1101-1105`    | Copies `URLSearchParams`; later duplicate keys overwrite earlier keys; `URLSearchParams` has already percent-decoded and treats `+` as space. Used by VLESS, Trojan, Hysteria 1, TUIC, Snell, AnyTLS, WireGuard. |
| `safeUrl`                   | `1107-1113`    | Wraps WHATWG `URL`; parser error text is propagated into a new error.                                                                                                                                            |
| `stripBrackets`             | `1115-1121`    | Removes one enclosing IPv6 bracket pair.                                                                                                                                                                         |
| `safeDecode`                | `1123-1129`    | One `decodeURIComponent` attempt; malformed input is returned unchanged.                                                                                                                                         |
| `splitList`                 | `1131-1136`    | Comma split, trim, remove empty values.                                                                                                                                                                          |
| `isPlainObject`             | `1138-1141`    | Accepts any non-null, non-array object; used for XHTTP nested JSON.                                                                                                                                              |
| `uniqueName`                | `1143-1154`    | First name unchanged; collisions receive ` #N`.                                                                                                                                                                  |
| `truncate`                  | `1156-1158`    | Baseline error-line protection is length-only (80 characters), not credential redaction.                                                                                                                         |
| `hasUnexpectedControlBytes` | `1160-1166`    | Allows tab, LF, CR; rejects other C0 bytes in decoded base64.                                                                                                                                                    |
| `extractEarlyDataFromPath`  | `297-311`      | SS/VMess WS-path helper; extracts numeric `ed`, deletes it, and reconstructs remaining path query pairs.                                                                                                         |
| `coerceAddonValue`          | `915-931`      | Coerces a small allowlist of AnyTLS/WireGuard bool/number keys; unknown addon values remain strings.                                                                                                             |

There are two materially different query semantics: manual `parseQueryString` preserves `+`, while WHATWG `URLSearchParams` converts `+` to a space. Both collapse repeated names with last-writer-wins.

## Per-family raw input and output inventory

All output lists below include only fields emitted by the baseline parser. `name`, `type`, `server`, and `port` are the common base fields.

### Shadowsocks (`parseSS`, `124-346`)

- Structural carriers: method/cipher and password in plain or base64 userinfo; host; port; fragment name. Legacy form base64-wraps `method:password@host:port` (`124-196`).
- Top-level query keys (20): `udp`, `tfo`, `uot`, `security`, `sni`, `peer`, `alpn`, `allowInsecure`, `insecure`, `fp`, `pbk`, `sid`, `type`, `path`, `host`, `serviceName`, `ws`, `wspath`, `plugin`, `shadow-tls` (`206-289`).
- Nested raw leaves (15 location-sensitive occurrences):
  - WS path subquery: `ed` (`297-311`).
  - `simple-obfs`/`obfs-local` plugin options: `obfs`, `obfs-host` (`324-329`).
  - `v2ray-plugin`/`xray-plugin` options: `tls`, `host`, `path`, `mux` (`330-337`).
  - `shadow-tls` plugin options: `host`, `password`, `version` (`338-345`).
  - base64 `shadow-tls` query JSON: `host`, `password`, `version`, `address`, `port` (`270-288`).
- Finite aliases/alternatives: `sni` or `peer` -> `sni`; `allowInsecure` or `insecure` -> `skip-cert-verify`; `type=ws`/`path` and legacy `ws=1`/`wspath`; plugin value aliases `simple-obfs`/`obfs-local` and `v2ray-plugin`/`xray-plugin`; `type=httpupgrade` -> output network `ws` plus upgrade flag.
- Top-level outputs (21 including base): `name`, `type`, `server`, `port`, `cipher`, `password`, `udp`, `tfo`, `udp-over-tcp`, `tls`, `sni`, `alpn`, `skip-cert-verify`, `client-fingerprint`, `reality-opts`, `network`, `ws-opts`, `h2-opts`, `grpc-opts`, `plugin`, `plugin-opts`.
- Nested outputs: `reality-opts.{public-key,short-id}`; `ws-opts.{path,v2ray-http-upgrade,v2ray-http-upgrade-fast-open,max-early-data,early-data-header-name,headers.Host}`; `h2-opts.{path,host}`; `grpc-opts.grpc-service-name`; `plugin-opts.{mode,host,tls,path,mux,password,version}`.
- Unknown policy: unrecognised top-level query keys and unrecognised plugin names/options are silently ignored. Malformed `shadow-tls` JSON is silently ignored (`285-287`).

### ShadowsocksR (`parseSSR`, `348-377`)

- Structural payload fields: host, port, protocol, method, obfs, base64 password. The parser splits five trailing colon-delimited fields so an IPv6 host may contain colons.
- Query keys (3): `remarks`, `obfsparam`, `protoparam`.
- Semantic mappings: `remarks` -> `name`; method -> `cipher`; `obfsparam` -> `obfs-param`; `protoparam` -> `protocol-param`.
- Outputs (11 including base): `name`, `type`, `server`, `port`, `cipher`, `password`, `obfs`, `protocol`, `obfs-param`, `protocol-param`, `udp`.
- Unknown policy: other SSR query keys, including common ecosystem `group`, are not read. Password base64 failure falls back to raw text; `remarks`, `obfsparam`, and `protoparam` base64 failure becomes an empty string.

### VMess (`parseVMess`, `379-440`)

- Carrier: one base64 JSON object.
- Read JSON keys (12): `add`, `port`, `ps`, `id`, `aid`, `scy`, `tls`, `sni`, `alpn`, `net`, `path`, `host`.
- Present-but-not-read fixture/ecosystem keys: the baseline fixture carries `v`; code does not read `v`. Code also does not read VMess `type`/header type or `fp`.
- Semantic mappings: `add` -> `server`; `ps` -> `name`; `id` -> `uuid`; `aid` -> `alterId`; `scy` -> `cipher`; `net` -> `network`; `sni` -> `servername`; `net=httpupgrade` -> `network=ws` plus upgrade flag. Numeric WS path subquery `ed` is extracted.
- Outputs (15 including base): `name`, `type`, `server`, `port`, `uuid`, `alterId`, `cipher`, `udp`, `tls`, `servername`, `alpn`, `network`, `ws-opts`, `h2-opts`, `grpc-opts`.
- Nested outputs: WS fields as above; `h2-opts.{path,host}`; `grpc-opts.grpc-service-name` (sourced from VMess `path`).
- Unknown policy: all other JSON keys are ignored. TLS is enabled only for stringified values `tls`, `true`, or `1`, case-insensitively (`404-411`).

### VLESS (`parseVLESS`, `442-688`)

- Structural carriers: URL username -> UUID; host; explicit port; fragment name.
- Top-level query keys (20): `flow`, `encryption`, `security`, `sni`, `fp`, `pcs`, `alpn`, `allowInsecure`, `insecure`, `pbk`, `sid`, `packetEncoding`, `type`, `headerType`, `path`, `host`, `serviceName`, `method`, `mode`, `extra`.
- Finite aliases/remaps:
  - `packetEncoding=packet` or `packetaddr` -> `packet-encoding: packetaddr`; `none` omits the field; every other value, including absence, emits `xudp` (`486-493`).
  - `type=http` -> network `h2`; `type=tcp` plus `headerType=http` -> network `http` (`495-502`).
  - gRPC service uses `serviceName`, falling back to `path` (`507-510`).
  - XHTTP nested aliases: `sessionIDPlacement`/`sessionPlacement` and `sessionIDKey`/`sessionKey` (`599-602`).
- Outputs (22 including base): `name`, `type`, `server`, `port`, `uuid`, `udp`, `flow`, `encryption`, `tls`, `servername`, `client-fingerprint`, `fingerprint`, `alpn`, `skip-cert-verify`, `reality-opts`, `packet-encoding`, `network`, `ws-opts`, `grpc-opts`, `h2-opts`, `http-opts`, `xhttp-opts`.
- Transport nested outputs:
  - `ws-opts.{path,headers.Host}`
  - `grpc-opts.grpc-service-name`
  - `h2-opts.{path,host}`
  - `http-opts.{path,method,headers.Host}`
  - XHTTP fields listed in the next subsection.
- Unknown policy: unrecognised top-level query keys are ignored; unknown `extra` fields and wrong-typed allowlisted fields are ignored. Malformed `extra` JSON is silently ignored (`534-540`).

#### VLESS XHTTP `extra` raw and output map

`applyXHTTPExtra` is at `553-688`. There are 45 location-sensitive raw leaf occurrences and 39 unique nested leaf spellings.

| Raw dotted path(s)                                    | Output dotted path                                     | Type guard / conversion                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extra.noGRPCHeader`                                  | `xhttp-opts.no-grpc-header`                            | Only literal boolean `true`.                                                                                                                              |
| `extra.xPaddingBytes`                                 | `xhttp-opts.x-padding-bytes`                           | Non-empty string.                                                                                                                                         |
| `extra.xPaddingObfsMode`                              | `xhttp-opts.x-padding-obfs-mode`                       | Boolean.                                                                                                                                                  |
| `extra.xPaddingKey`                                   | `xhttp-opts.x-padding-key`                             | Non-empty string.                                                                                                                                         |
| `extra.xPaddingHeader`                                | `xhttp-opts.x-padding-header`                          | Non-empty string.                                                                                                                                         |
| `extra.xPaddingPlacement`                             | `xhttp-opts.x-padding-placement`                       | Non-empty string.                                                                                                                                         |
| `extra.xPaddingMethod`                                | `xhttp-opts.x-padding-method`                          | Non-empty string.                                                                                                                                         |
| `extra.uplinkHttpMethod`                              | `xhttp-opts.uplink-http-method`                        | Non-empty string.                                                                                                                                         |
| `extra.sessionIDPlacement` / `extra.sessionPlacement` | `xhttp-opts.session-placement`                         | First non-empty string in that precedence order.                                                                                                          |
| `extra.sessionIDKey` / `extra.sessionKey`             | `xhttp-opts.session-key`                               | First non-empty string in that precedence order.                                                                                                          |
| `extra.sessionIDTable`                                | `xhttp-opts.session-table`                             | Non-empty string.                                                                                                                                         |
| `extra.sessionIDLength`                               | `xhttp-opts.session-length`                            | Final implementation strictly validates an integer/range, caps endpoint and range cardinality at 256, and emits one canonical decimal/range string.       |
| `extra.seqPlacement`                                  | `xhttp-opts.seq-placement`                             | Non-empty string.                                                                                                                                         |
| `extra.seqKey`                                        | `xhttp-opts.seq-key`                                   | Non-empty string.                                                                                                                                         |
| `extra.uplinkDataPlacement`                           | `xhttp-opts.uplink-data-placement`                     | Non-empty string.                                                                                                                                         |
| `extra.uplinkDataKey`                                 | `xhttp-opts.uplink-data-key`                           | Non-empty string.                                                                                                                                         |
| `extra.uplinkChunkSize`                               | `xhttp-opts.uplink-chunk-size`                         | Final implementation accepts only a positive JSON safe integer and emits its exact decimal string; zero rejects because it can loop in the fixed runtime. |
| `extra.scMaxEachPostBytes`                            | `xhttp-opts.sc-max-each-post-bytes`                    | Final implementation accepts only a positive JSON safe integer and emits its exact decimal string.                                                        |
| `extra.scMinPostsIntervalMs`                          | `xhttp-opts.sc-min-posts-interval-ms`                  | Final implementation accepts only a positive JSON safe integer and emits its exact decimal string.                                                        |
| `extra.xmux.maxConnections`                           | `reuse-settings.max-connections`                       | Final implementation strictly validates an integer/range and emits an exact decimal/range string; positive concurrency conflicts.                         |
| `extra.xmux.maxConcurrency`                           | `reuse-settings.max-concurrency`                       | Final implementation strictly validates an integer/range and emits an exact decimal/range string; positive connections conflicts.                         |
| `extra.xmux.cMaxReuseTimes`                           | `reuse-settings.c-max-reuse-times`                     | Final implementation strictly validates and emits an exact decimal/range string.                                                                          |
| `extra.xmux.hMaxRequestTimes`                         | `reuse-settings.h-max-request-times`                   | Final implementation strictly validates and emits an exact decimal/range string.                                                                          |
| `extra.xmux.hMaxReusableSecs`                         | `reuse-settings.h-max-reusable-secs`                   | Final implementation strictly validates and emits an exact decimal/range string.                                                                          |
| `extra.xmux.hKeepAlivePeriod`                         | `reuse-settings.h-keep-alive-period`                   | Final implementation accepts an exact non-negative integer capped for fixed-target duration conversion.                                                   |
| `extra.downloadSettings.address`                      | `download-settings.server`                             | Non-empty string.                                                                                                                                         |
| `extra.downloadSettings.port`                         | `download-settings.port`                               | Final implementation requires an exact integer in 1..65535.                                                                                               |
| `extra.downloadSettings.security`                     | `download-settings.tls`                                | Case-folded `tls` or `reality` only.                                                                                                                      |
| `...tlsSettings.serverName`                           | `download-settings.servername`                         | Non-empty string.                                                                                                                                         |
| `...tlsSettings.fingerprint`                          | `download-settings.client-fingerprint`                 | Non-empty string.                                                                                                                                         |
| `...tlsSettings.alpn[]`                               | `download-settings.alpn[]`                             | Array filtered to string elements.                                                                                                                        |
| `...tlsSettings.allowInsecure`                        | `download-settings.skip-cert-verify`                   | Only literal boolean `true`.                                                                                                                              |
| `...realitySettings.publicKey`                        | `download-settings.reality-opts.public-key`            | Non-empty string.                                                                                                                                         |
| `...realitySettings.shortId`                          | `download-settings.reality-opts.short-id`              | Non-empty string.                                                                                                                                         |
| `...xhttpSettings.path`                               | `download-settings.path`                               | Non-empty string.                                                                                                                                         |
| `...xhttpSettings.host`                               | `download-settings.host`                               | Non-empty string.                                                                                                                                         |
| `...xhttpSettings.headers`                            | `download-settings.headers`                            | Non-empty plain object, values not further validated.                                                                                                     |
| `...xhttpSettings.extra.xmux.{six fields above}`      | `download-settings.reuse-settings.{six outputs above}` | Same conversion helper as top-level `xmux`; these six repeated dotted leaves bring the location-sensitive total to 45.                                    |

### Trojan (`parseTrojan`, `690-727`)

- Structural carriers: username -> password; host; optional port (default 443); fragment name.
- Query keys (10): `sni`, `peer`, `alpn`, `allowInsecure`, `insecure`, `fp`, `type`, `path`, `host`, `serviceName`.
- Aliases: `sni`/`peer`; `allowInsecure`/`insecure`.
- Outputs (13 including base): `name`, `type`, `server`, `port`, `password`, `udp`, `sni`, `alpn`, `skip-cert-verify`, `client-fingerprint`, `network`, `ws-opts`, `grpc-opts`.
- Unknown policy: unrecognised query keys are ignored. A non-`tcp` unknown `type` is emitted as `network` without an option object.

### Hysteria 1 (`parseHysteria`, `729-753`)

- Structural carriers: host, explicit port, fragment name. URL userinfo is not read.
- Query keys (12): `auth`, `auth_str`, `peer`, `sni`, `up`, `upmbps`, `down`, `downmbps`, `alpn`, `protocol`, `obfs`, `insecure`.
- Alias groups: `auth`/`auth_str`; `peer`/`sni`; `up`/`upmbps`; `down`/`downmbps`.
- Outputs (12 including base): `name`, `type`, `server`, `port`, `auth-str`, `sni`, `up`, `down`, `alpn`, `protocol`, `obfs`, `skip-cert-verify`.
- Unknown policy: unrecognised query keys are ignored; `insecure` accepts only exact string `1`.

### Hysteria 2 (`parseHysteria2`, `755-826`)

- Structural carriers: optional password before the last `@`; bracketed IPv6 or host; optional single port or comma/semicolon-separated port/range set; fragment name. Default port is 443.
- Query keys (14): `sni`, `peer`, `insecure`, `obfs`, `obfs-password`, `alpn`, `pinSHA256`, `fastopen`, `mport`, `hop-interval`, `hop_interval`, `keepalive`, `upmbps`, `downmbps`.
- Aliases/precedence: schemes `hysteria2`/`hy2`; `sni` then `peer`; authority port set overrides `mport`; `hop-interval` overrides `hop_interval`.
- Outputs (17 including base): `name`, `type`, `server`, `port`, `password`, `ports`, `sni`, `skip-cert-verify`, `obfs`, `obfs-password`, `alpn`, `fingerprint`, `tfo`, `hop-interval`, `keepalive`, `up`, `down`.
- Unknown policy: unrecognised query keys are ignored. `obfs=none` is suppressed. `insecure` and `fastopen` accept `1`/`true`, case-insensitively.

### TUIC (`parseTUIC`, `828-854`)

- Structural carriers: URL username -> UUID; URL password -> password; host; explicit port; fragment name.
- Query keys (7): `sni`, `alpn`, `congestion_control`, `udp_relay_mode`, `allow_insecure`, `insecure`, `disable_sni`.
- Alias group: `allow_insecure`/`insecure` -> `skip-cert-verify`.
- Outputs (12 including base): `name`, `type`, `server`, `port`, `uuid`, `password`, `sni`, `alpn`, `congestion-controller`, `udp-relay-mode`, `skip-cert-verify`, `disable-sni`.
- Unknown policy: unrecognised query keys are ignored. The three booleans accept only exact string `1`.

### Snell (`parseSnell`, `856-878`)

- Structural carriers: URL username -> PSK; host; explicit port; fragment name.
- Query keys (3): `version`, `obfs`, `obfs-host`.
- Outputs (7 including base): `name`, `type`, `server`, `port`, `psk`, `version`, `obfs-opts`; nested `obfs-opts.{mode,host}`.
- Unknown policy: unrecognised query keys are ignored. `version` is `parseInt`-coerced without an explicit finite/range check.

### AnyTLS (`parseAnyTLS`, `915-965`)

- Structural carriers: URL username -> password; host; optional port (default 443); fragment name.
- Direct query keys (6): `sni`, `peer`, `alpn`, `insecure`, `fp`, `udp`.
- Additional statically typed passthrough keys (5 beyond the direct set): `tfo`, `mptcp`, `skip-cert-verify`, `remote-dns-resolve`, `persistent-keepalive` (`udp` is also in the bool allowlist but is already counted directly).
- Alias/normalisation: `sni`/`peer`; every other non-empty raw key has all `_` characters replaced with `-`.
- Named outputs (10 before wildcard): `name`, `type`, `server`, `port`, `password`, `udp`, `sni`, `alpn`, `skip-cert-verify`, `client-fingerprint`, plus arbitrary top-level addon fields.
- Unknown policy: pass through every non-empty, non-handled query key unless the normalised key already exists on the proxy. Known bool keys map any non-`1`/`true` value to `false`; `persistent-keepalive` is parsed as integer when possible; all other values stay strings.

### WireGuard (`parseWireGuard`, `968-1035`)

- Structural carriers: URL username -> private key; host; optional port (default 51820); fragment name.
- Special raw spellings (10): `reserved`, `address`, `ip`, `mtu`, `publickey`, `public-key`, `privatekey`, `private-key`, `udp`, `flag`.
- Additional statically typed passthrough keys (5 beyond `udp`): `tfo`, `mptcp`, `skip-cert-verify`, `remote-dns-resolve`, `persistent-keepalive`.
- Alias/normalisation: schemes `wireguard`/`wg`; `address`/`ip`; case-insensitive `publickey`/`public-key`; case-insensitive `privatekey`/`private-key`; generic `_` -> `-` for all other keys.
- Named outputs (13 before wildcard): `name`, `type`, `server`, `port`, `private-key`, `udp`, `reserved`, `ip`, `ip-cidr`, `ipv6`, `ipv6-cidr`, `mtu`, `public-key`, plus arbitrary top-level addon fields.
- Special behavior: exactly three parseable comma-separated `reserved` integers are emitted; each address is classified as IPv4 or colon-containing IPv6, with CIDR range guards; later addresses of the same family overwrite earlier ones; `flag` is explicitly dropped.
- Unknown policy: pass through every other non-empty query key unless it collides with an existing output field. No `peers` object is constructed.

### SOCKS (`parseSocks`, `880-908`)

- Structural carriers: host; explicit port; fragment name; credentials in URL userinfo.
- Query keys: none.
- Credential alternatives: if percent-decoded username itself base64-decodes to a string containing `:`, that decoded value supplies username/password; otherwise URL username/password are used directly.
- Outputs (7 including base): `name`, `type`, `server`, `port`, `udp`, `username`, `password`. Empty credentials are omitted.
- Unknown policy: URL query and path are not inspected after `URL` parsing.

### HTTP/HTTPS proxy (`parseHttp`, `1037-1056`)

- Structural carriers: host; required explicit port; fragment name; URL username/password. Path must be empty or `/`.
- Query keys: none.
- Scheme variant: `https` shares this parser and emits `tls: true`.
- Outputs (7 including base): `name`, `type`, `server`, `port`, `username`, `password`, `tls`.
- Unknown policy: root-path query parameters are accepted by `URL` but ignored. Non-root paths are rejected before the explicit-port check.

## Call chain: URI input to delivered Mihomo YAML/config

The direction is `normaliseToClashProxies -> parseProxyUriList`; `parseProxyUriList` is the leaf URI parser called by the normaliser.

```text
local Subscription.content
  -> resolveSubscriptionRaw                           subscriptionFetcher.ts:258-270
  -> normaliseToClashProxies

remote HTTP response body
  -> fetchSubscriptionInternal                        subscriptionFetcher.ts:339-382
  -> normaliseToClashProxies

normaliseToClashProxies                               subscriptionFetcher.ts:451-499
  1. strip one BOM + trim
  2. parse direct YAML/JSON-as-YAML and extract `proxies` array
  3. decode one base64 layer; try decoded YAML
  4. select direct or decoded URI-list text via looksLikeProxyUriList
  5. parseProxyUriList                                uriToClash.ts:90-118
  6. return parsed proxy objects

objects
  -> rawFromProxies                                   subscriptionFetcher.ts:87-97
     -> lazy provider YAML stringify, or
     -> plain-object filtering
  -> raw cache entry as provider YAML                 subscriptionFetcher.ts:300-310

delivery branches
  -> resolveSubscriptionContent / ContentRaw          subscriptionFetcher.ts:139-164,204-216
     -> provider YAML string
  -> resolveSubscriptionProxies / ProxiesRaw          subscriptionFetcher.ts:173-195,229-240
     -> operators where applicable
     -> engine config injection                       engine/resolve.ts:203-228
     -> source/collection export                      nodeExportService.ts:55-67,84-127
     -> HTTP provider response                        providerResponse.ts:10-44
  -> normaliseToClashProviderYaml                     subscriptionFetcher.ts:417-420
  -> parseLocalProxies                                subscriptionFetcher.ts:430-435
     -> local-node list/rename helpers                 localNodeWrites.ts:74,114,131
```

Cache-hit behavior is a separate branch: a fresh cache hit uses `rawFromYaml(cached.content)` and does not re-run `normaliseToClashProxies` (`subscriptionFetcher.ts:278-290`). The baseline cache identity contains URL, UA, and custom headers, but no parser schema/version (`278-307`).

Recognition order matters:

1. Any YAML document (including JSON accepted by the YAML library) with an array-valued top-level `proxies` wins and bypasses URI parsing.
2. Only one base64 layer is tried.
3. Mixed ordinary text and proxy URI lines are permitted by `parseProxyUriList`; non-scheme lines are skipped.
4. At the clean baseline, a list with at least one parsed proxy returns that partial proxy list even if other recognised lines failed. This behavior is being changed concurrently; see below.

## Test coverage inventory

Baseline `proxyUri.test.ts` contains 75 `it(...)` blocks, four of which test unrelated proxy-group filtering. The parser-family minimum is present for 12 of 13 families; Hysteria 1 has no direct invocation.

| Family / behavior            | Existing baseline anchors                                           | Obvious untested read fields or branches                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry/helpers             | `proxyUri.test.ts:11-40`, `469-482`                                 | Scheme case variation; BOM; Unicode/control fragments; repeated query names; query-key case variants; mixed success/failure; error redaction.                                                                                   |
| SS                           | `43-69`, `247-323`, `500-518`, `901-918`                            | `peer`, `allowInsecure`/`insecure`, h2, gRPC `serviceName`, legacy `ws`/`wspath`, v2ray/xray plugin options, plugin-form shadow-TLS, malformed nested payload, unknown plugin/query behavior.                                   |
| SSR                          | `71-92`, `520-532`                                                  | No assertion for `protoparam`/`protocol-param`; malformed/raw password fallback; `group` non-support; invalid port.                                                                                                             |
| VMess                        | `94-125`, `921-943`, `969-1009`                                     | `alpn`; h2 and gRPC option objects; ignored `type`/`fp`; malformed scalar types; unknown JSON fields.                                                                                                                           |
| VLESS                        | `127-147`, `325-331`, `579-868`                                     | `allowInsecure`/`insecure`; `http-opts.method`; gRPC `path` fallback; most XHTTP leaves listed below; unknown security/transport; repeated params and key-case variants.                                                        |
| Trojan                       | `149-164`, `493-498`                                                | `peer`, `alpn`, both insecure aliases, `fp`, gRPC, default 443, unknown transport.                                                                                                                                              |
| Hysteria 1                   | none                                                                | Every branch and all 12 query keys.                                                                                                                                                                                             |
| Hysteria 2                   | `166-182`, `397-429`, `454-459`, `534-546`, `871-898`               | `alpn`; `hop_interval`; default 443; semicolon port sets; `insecure=true`; invalid/zero/out-of-range port components.                                                                                                           |
| TUIC                         | `184-201`, `548-553`                                                | `allow_insecure`, `insecure`, `disable_sni`; empty password; invalid scalar/value variants.                                                                                                                                     |
| Snell                        | `232-245`                                                           | Invalid/non-numeric `version`, absent/default version, unknown obfs/value handling.                                                                                                                                             |
| AnyTLS                       | `333-363`, `431-436`, `946-952`                                     | `mptcp`, `remote-dns-resolve`, `persistent-keepalive`, direct `skip-cert-verify`, wildcard underscore normalisation, collision guard, false/invalid typed values, common idle timeout/min-idle knobs.                           |
| WireGuard                    | `365-395`, `954-966`                                                | `ip` alias, query private-key override, hyphenated public/private spellings, `udp=false`, `flag` drop, `tfo`/`mptcp`/`skip-cert-verify`, underscore aliases, malformed reserved/address/CIDR, multiple addresses of one family. |
| SOCKS                        | `203-216`                                                           | `socks` scheme alias; base64 credential branch; no-auth; path/query handling; IPv6.                                                                                                                                             |
| HTTP(S)                      | `218-230`, `461-467`                                                | `https` TLS branch; no-auth; root `/`; query discard; invalid/zero/out-of-range port.                                                                                                                                           |
| Normaliser                   | `proxyUri.test.ts:438-452,556-575,733-767`; `fetcher.test.ts:54-98` | Mixed URI partial failure; unsupported-only URI through `looksLikeProxyUriList`; double base64; BOM; YAML per-node validation; parser-version cache invalidation.                                                               |
| Object/string/cache pipeline | `objectPipeline.test.ts:87-238`                                     | Parser-upgrade cache invalidation; URI-originated cache entry after parser semantics change; invalid objects reaching the string provider path.                                                                                 |

XHTTP assertions cover `xPaddingBytes`, `scMaxEachPostBytes`, `xmux.maxConnections`, `xmux.maxConcurrency`, `xmux.hKeepAlivePeriod`, and a Reality download with address, port, public key, short ID, path, and host (`proxyUri.test.ts:809-856`). They do not directly cover:

- `noGRPCHeader`, `xPaddingObfsMode`, `xPaddingKey`, `xPaddingHeader`, `xPaddingPlacement`, `xPaddingMethod`, `uplinkHttpMethod`;
- both session placement aliases, both session key aliases, `sessionIDTable`, string/number `sessionIDLength`;
- `seqPlacement`, `seqKey`, `uplinkDataPlacement`, `uplinkDataKey`, `uplinkChunkSize`, `scMinPostsIntervalMs`;
- `xmux.cMaxReuseTimes`, `xmux.hMaxRequestTimes`, `xmux.hMaxReusableSecs`;
- download TLS `serverName`, `fingerprint`, `alpn`, `allowInsecure`;
- download XHTTP `headers` and nested `extra.xmux`;
- wrong types, empty strings, unknown leaves, and recursive/nesting boundaries.

## Candidate findings requiring evidence/contract decisions

These are baseline code facts and audit leads, not pre-classified confirmed bugs. Each needs protocol/target evidence and, where applicable, an end-to-end reproduction before severity assignment.

| ID    | Locus at baseline                                                                 | Trigger shape using synthetic placeholders                                              | Observed baseline behavior                                                                                                                                                      | Existing guard                                                                                                                                     | Evidence/decision still needed                                                                                                                          |
| ----- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PI-01 | `subscriptionFetcher.ts:480-493`, `normaliseToClashProxies`                       | One valid recognised URI line plus one malformed recognised URI line                    | Returns the successfully parsed subset; `errors` is discarded once `proxies.length > 0`.                                                                                        | If every recognised URI fails, a sampled error is thrown.                                                                                          | Product contract for partial subscriptions and warning/fail-closed behavior. Concurrent remediation is in progress.                                     |
| PI-02 | `uriToClash.ts:103,110-114,1156-1158`; `subscriptionFetcher.ts:485-492`           | A malformed known-scheme line whose credential occurs near the beginning                | Error object retains up to 80 characters of the original line, and the normaliser interpolates it into a client-visible error.                                                  | Length truncation only; no baseline credential-aware masking.                                                                                      | Trace every error/log/API surface and define a redaction contract. Concurrent remediation is in progress.                                               |
| PI-03 | `uriToClash.ts:1088-1105`                                                         | Repeated `alpn`, host, token, or addon query names                                      | Both query helpers overwrite earlier values with the final value.                                                                                                               | None; comma-separated values are split later only for selected fields.                                                                             | Per-protocol repeated-parameter rules and whether repeated values should merge, reject, or last-win.                                                    |
| PI-04 | All `params.*` accesses; especially `449-543`, `697-725`, `734-752`               | A documented key with different case or hyphen/underscore spelling                      | Most protocols use exact key spelling and silently ignore the variant. Public/private WireGuard key regexes are exceptional; AnyTLS/WireGuard normalise underscores.            | No global key canonicaliser.                                                                                                                       | Official sharing specs and client compatibility evidence before adding aliases.                                                                         |
| PI-05 | `uriToClash.ts:469-484`, VLESS security                                           | `security=<unknown>` or Reality without a public key                                    | Unknown non-TLS-suffix security is accepted with TLS absent. Reality without `pbk` emits `tls: true` but no `reality-opts`.                                                     | `security.endsWith('tls')`/`reality`; Reality object is only created when `pbk` exists, preventing an empty object.                                | Whether target conversion must reject/warn rather than accept a possibly degraded node; confirm accepted security values in fixed Mihomo/Xray versions. |
| PI-06 | `181`, `359-369`, `391-392`, `695`, `775-795`, `940`, `976`, `1050`               | Port `0`, trailing junk in hand-parsed forms, or value above 65535                      | Validation differs by family; some use truthiness/default fallback, some only check positive, SSR has no explicit check, and Hysteria 2 custom parsing can retain large values. | WHATWG `URL` rejects some invalid ports for URL-based parsers; SS only rejects non-finite/non-positive; Hysteria 2 regex limits syntax, not range. | Uniform accepted range and whether explicit zero may ever mean default.                                                                                 |
| PI-07 | `uriToClash.ts:956-964`, `986-1008`                                               | AnyTLS/WireGuard `?arbitrary_key=value`                                                 | Unknown non-empty addons become top-level Mihomo fields after `_` -> `-`; unknown values stay strings.                                                                          | Empty values, handled keys, existing-output collisions, and WireGuard `flag` are skipped; small scalar allowlist is coerced.                       | Target schema validation and per-protocol allowlist/pass-through policy. This also prevents a finite raw-key/alias count without wildcard rows.         |
| PI-08 | `subscriptionFetcher.ts:501-511`, `rawFromProxies:87-97`                          | `proxies:` array containing null/scalars or objects with invalid/missing Mihomo fields  | YAML recognition checks only that `proxies` is an array. String delivery can retain degenerate entries; object consumers filter only non-objects, not schema-invalid objects.   | Plain-object filter on object path; `objectPipeline.test.ts:227-238` characterises the string/object difference.                                   | Product promise for accepting raw provider YAML and where fixed-version Mihomo validation must occur.                                                   |
| PI-09 | `subscriptionFetcher.ts:278-307`                                                  | Parser semantics change while a fresh cached provider-YAML entry exists                 | Cache hit bypasses URI parsing and returns the old normalised YAML until freshness expires; stale fallback can live longer.                                                     | TTL/fetched-at freshness and seven-day stale retention; cache key covers URL, UA, headers.                                                         | Parser/cache schema versioning or explicit invalidation strategy.                                                                                       |
| PI-10 | `uriToClash.ts:1037-1055`, HTTP parser                                            | Root-path `http(s)://host:explicit-port/?query` that is actually a web/subscription URL | It is accepted as an HTTP proxy; query is ignored. Only non-root path is rejected.                                                                                              | Explicit port required; non-root path rejected.                                                                                                    | URI/container recognition contract and acceptable ambiguity policy.                                                                                     |
| PI-11 | `uriToClash.ts:270-288`, `534-540`, `553-688`                                     | Malformed SS shadow-TLS JSON, malformed VLESS `extra`, or wrong-typed nested fields     | Node still parses and the nested capability is omitted.                                                                                                                         | JSON parse/type guards prevent invalid objects from being emitted.                                                                                 | Whether silent omission matches project policy or requires per-node warning/rejection for security/transport fields.                                    |
| PI-12 | `uriToClash.ts:4-7`; `subscriptionFetcher.ts:496-498`; registry `33-51,1058-1076` | Generic no-recognisable-input error                                                     | Human-readable supported lists omit registered schemes/families such as Hysteria 1, AnyTLS, WireGuard and some aliases.                                                         | `KNOWN_SCHEMES` and `PARSERS` themselves are in sync at baseline.                                                                                  | Decide whether messages show canonical families or all aliases; generate from registry to prevent drift.                                                |
| PI-13 | `uriToClash.ts:193-195,217,252-253,1088-1097`                                     | SS `alpn` or host carrying `%25`-encoded percent sequences                              | `parseQueryString` decodes once, then selected SS fields call `safeDecode` again; other SS fields do not.                                                                       | `safeDecode` catches malformed escapes only; there is no decode-depth marker.                                                                      | Differential fixtures and specification for exactly-once decoding.                                                                                      |
| PI-14 | `uriToClash.ts:729-753`; no `hysteria://` in direct tests                         | Any Hysteria 1 URI                                                                      | Registered parser behavior has no direct characterization test.                                                                                                                 | Host/port required; individual optional fields guarded by presence.                                                                                | Fixed-version Mihomo support boundary and a minimum/full synthetic fixture before modification.                                                         |

Additional bounded observations for later matrix work:

- Most families silently ignore unknown query/JSON fields; AnyTLS and WireGuard do the opposite and pass them through. This is a policy inconsistency, not by itself proof that either behavior is wrong.
- VLESS packet encoding defaults to emitted `packet-encoding: xudp` when `packetEncoding` is absent because `undefined !== 'none'` (`489-493`). Tests explicitly characterise this (`proxyUri.test.ts:769-800`); standards/core evidence must decide whether the project should preserve it.
- Trojan, AnyTLS, and WireGuard convert an explicit/invalid zero port to their default via `parseInt(...) || default`; Hysteria 2 leaves its initialized default when a single parsed port is not positive. Whether this is compatibility or invalid-input masking needs a common contract.
- SS TLS wrapping accepts every non-`none` `security` value and enables TLS (`213-227`), while VLESS uses a different allow pattern. The audit should not homogenise this without protocol evidence.

## Concurrent audit changes

The clean baseline behavior above remains the reference for initial counts. During this workstream, the coordinator confirmed these in-progress changes in the shared worktree:

1. credential-aware error redaction in `uriToClash.ts`/tests (addresses the baseline lead PI-02);
2. fail-closed handling of recognised mixed URI lists in `subscriptionFetcher.ts`/tests (addresses the baseline lead PI-01).

These changes must be independently reviewed and the inventory/matrix status updated after they settle. Their current worktree line numbers and assertions are deliberately not treated as baseline evidence here.

## Suggested ownership for implementation/testing

No ownership is claimed beyond this workstream document. Recommended edit boundaries for the coordinator:

| Work item                                                                     | Candidate files                                                                                              | Collision note                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Shared URI registry, query helpers, scalar/port policy, redacted diagnostics  | `web/lib/proxies/uriToClash.ts` or future shared parsing modules; `web/tests/subscriptions/proxyUri.test.ts` | Central/high-conflict; one integration owner only.                              |
| Normaliser partial-failure, supported-list generation, YAML object validation | `web/lib/services/subscriptionFetcher.ts`; focused subscription tests                                        | Coordinate with cache work because the same normaliser produces cached content. |
| Cache schema/version                                                          | `web/lib/repos/fetchCacheRepo.ts`, `web/lib/services/subscriptionFetcher.ts`, cache/object-pipeline tests    | Must preserve stale fallback semantics or migrate deliberately.                 |
| SS/SSR/VMess fixtures                                                         | New dedicated fixture/test file if possible                                                                  | Avoid concurrent edits to the monolithic parser test.                           |
| VLESS/Trojan/transport/XHTTP fixtures                                         | New dedicated fixture/test file; eventual protocol module                                                    | XHTTP nested map is large enough to isolate.                                    |
| Hysteria 1/2 and TUIC fixtures                                                | New dedicated fixture/test file; eventual protocol module                                                    | Hysteria 1 needs characterization before fixes.                                 |
| AnyTLS/WireGuard/Snell/SOCKS/HTTP fixtures                                    | New dedicated fixture/test file; eventual protocol module                                                    | Define wildcard/pass-through contract before tightening.                        |
| Full delivery/binary validation                                               | New end-to-end fixtures plus engine/export tests                                                             | Use only generated synthetic credentials and minimal full Mihomo wrappers.      |

## Reproduction checklist for this inventory

To recompute this report against the frozen baseline without reading concurrent edits:

```bash
git show 9596cec88fb17fd67ed7102b625b18bb92e9f68f:web/lib/proxies/uriToClash.ts
git show 9596cec88fb17fd67ed7102b625b18bb92e9f68f:web/lib/services/subscriptionFetcher.ts
git show 9596cec88fb17fd67ed7102b625b18bb92e9f68f:web/tests/subscriptions/proxyUri.test.ts
```

Recount rules:

1. Count `KNOWN_SCHEMES` literal members.
2. Deduplicate function references in `PARSERS` for parser-family count.
3. For top-level raw fields, count only exact property names read from protocol query records or VMess JSON, once per family; record AnyTLS/WireGuard wildcard separately.
4. For nested fields, use the full dotted location. Repeated `xmux` leaves under download settings count again as location-sensitive occurrences.
5. For output fields, count statically named top-level keys and keep arbitrary addon output as a wildcard, not a guessed list.
6. Do not infer standard support from an implementation branch or fixture. Every status beyond “current behavior” needs official docs, fixed-commit source, or fixed-version binary evidence.
