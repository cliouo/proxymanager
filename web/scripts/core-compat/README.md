# Mihomo real-connectivity lab

From `web/`:

```sh
npx tsx scripts/core-compat/run.ts
LAB_MODE=clients npx tsx scripts/core-compat/run.ts
LAB_MODE=reality npx tsx scripts/core-compat/run.ts
CASE_FILTER='^(vless-reality|vless-xhttp)' npx tsx scripts/core-compat/run.ts
npx tsx scripts/core-compat/selftest.ts
```

Requires Node/project dependencies, curl, OpenSSL, and Linux amd64 cores. No root,
TUN device, external target, or production credentials are used. All listeners
bind to `127.0.0.1`. The harness never downloads binaries or contacts external
servers. Dynamic port allocation has the usual close/rebind race; a concurrent
process claiming a port will be reported as a startup/connectivity error.

| Binary default                     | Environment override |
| ---------------------------------- | -------------------- |
| `~/cores/mihomo`                   | `MIHOMO_BIN`         |
| `~/cores/sing-box`                 | `SING_BOX_BIN`       |
| `~/cores/xray`                     | `XRAY_BIN`           |
| `~/cores/xray-1.8.24/xray`         | `XRAY18_BIN`         |
| `~/cores/xray-25.3.6/xray`         | `XRAY25_BIN`         |
| `~/cores/v2ray-plugin_linux_amd64` | `V2RAY_PLUGIN_BIN`   |
| `~/cores/snell4/snell-server`      | `SNELL4_BIN`         |
| `~/cores/snell5/snell-server`      | `SNELL5_BIN`         |

Use absolute paths for overrides. Main setup requires Xray for fresh Reality,
WireGuard and VLESS encryption material even with `CASE_FILTER`. Missing optional
server binaries yield **no server available**, not a connectivity pass. SSR is
explicitly unavailable. Tested versions: Mihomo v1.19.34, sing-box 1.14.4,
Xray 26.11.9, v2ray-plugin 5.54.2, Snell 4.1.1 and 5.0.1. Server configuration
schemas are version-sensitive (notably Xray mKCP `finalmask`).

## What a result proves

Every fixture starts with a share URI, calls `parseProxyUriList` and
`validateMihomoProxyList`, writes the resulting node unchanged into a minimal
YAML config, and runs `mihomo -t`. Available real servers and a Mihomo client
then run as child processes. Curl uses the mixed port as a SOCKS proxy with
`--noproxy ''`; a random nonce returned by a local HTTP server must match exactly.
Direct-target and dead-proxy negative baselines guard against bypassing the proxy.
Processes are terminated after each case and on interruption. A failed stage sets
the process exit code to 1; unavailable servers are N/A, not failures.

Reports, stage results, URI fixtures, configs, core versions, certificates/keys,
and logs live in gitignored `web/.tmp/core-compat/<timestamp>-<pid>/`. These contain
ephemeral **lab** secrets; do not publish the full directory or use real credentials.
No product code is patched. One combined Markdown report keeps YAML connectivity,
Reality flag comparisons, and share-link import connectivity in separate columns.

The link stage calls `proxiesToShareUris`, re-parses the exported URI and reports
every structurally changed/added/lost field path (object key order is ignored;
array order and explicit defaults are not). It writes `buildBase64Subscription`
output verbatim into a file proxy-provider and lets Mihomo import the links.
A separate client/home/config is used. Before curling, the local controller must
confirm the select group has exactly one imported node selected; empty-provider
DIRECT/COMPATIBLE fallback is forbidden. Export skips are not silently replaced
with the original YAML node. WireGuard uses the product's flat `wireguard://` exporter.

TLS uses a fresh two-day localhost certificate with skip-verification URI fields
where supported. Plugins without that URI option trust the lab CA using only the
child process's `SSL_CERT_FILE`. Reality's TLS camouflage is also entirely local.
WireGuard uses an Xray userspace server: a virtual destination `198.18.0.1` is
redirected to the HTTP target because the userspace stack rejects loopback
destinations. SS simple-obfs/shadow-tls use native Mihomo server implementations;
v2ray-plugin and Snell use their separate real server executables.

Hysteria2 port hopping uses 16 localhost UDP relays to one server, counts ports
used during a seven-second streamed HTTP response, and reports hop diversity
separately. A successful request with one observed port is **HOP UNVERIFIED**.
No general UDP-over-proxy or WAN performance/compatibility claim is made.

For failed Xray-backed VMess/VLESS requests, the harness also tries a same-server
Xray control client. This helps separate server/target setup from interoperability
but is not proof of a product bug. Every Reality case additionally tries a
separate Mihomo config with `support-x25519mlkem768: true`; this does not alter the
original emitted YAML or turn its FAIL into a PASS. Vision/gRPC fixtures include
both Xray and sing-box servers. Inspect separate configs/logs before attributing
a failure to parser output or a core.

The flag passes the current installed servers but **breaks Xray 1.8.24 and
25.3.6** in the Vision/gRPC localhost tests; unset passes those older servers.
Do not interpret the current-server passes as a safe universal default.
Mihomo's Reality implementation explicitly disables the hybrid key share by
default for old Reality servers. No standard share-link
parameter for this boolean was found in the [Xray share-link proposal](https://github.com/XTLS/Xray-core/discussions/716)
or [v2rayN's URI reader/writer](https://github.com/2dust/v2rayN/blob/master/v2rayN/ServiceLib/Handler/Fmt/BaseFmt.cs).
`pqv` means the ML-DSA-65 verification key, not X25519MLKEM768 support; `fp` chooses
the TLS fingerprint and does not explicitly advertise the server's capabilities.

## Native-client mappings

`clients.ts` is a harness-only, fixture-scope mapper, not a production exporter or
an emulation of any GUI's complete import pipeline. It consumes the parsed node,
not server configuration. Each supported mapping gets its own SOCKS inbound,
native core config validation (`sing-box check` / `xray run -test`), then a real
nonce fetch against the same server. Configs, config-test logs and connection logs
are saved as `mapped-<core>.*`. Unsupported mappings never fall back to DIRECT.
Unknown/unmapped fields return an explicit harness-coverage limitation instead
of being silently discarded. Notes record schema translations and missing info.

Schemas are pinned to the installed versions: [sing-box outbound docs](https://sing-box.sagernet.org/configuration/outbound/),
[WireGuard endpoint docs](https://sing-box.sagernet.org/configuration/endpoint/wireguard/),
and [Xray transport docs](https://xtls.github.io/config/transport.html), checked
against those release tags' `option/` and `infra/conf/` schema implementations.
Examples: SS plugins become SIP003 strings or a separate shadowtls detour;
gRPC service names change casing; WS early data becomes transport fields or an
`ed` path query; Hysteria2 obfs becomes an object; hopping becomes colon-delimited
port ranges (including `n:n` singleton ranges) plus a duration; TUIC congestion
and relay mode use underscore names; flat WG becomes a userspace endpoint/peer.
Native-client port-hopping requests use the streamed target, but counts do not
claim per-core hop diversity. WS early-data and explicit TUIC option translation
have mapper assertions, not new network fixtures exercising those options.
The existing hopping fixture requests a one-second interval: both native clients
have a five-second minimum and are UNSUPPORTED for that feature. The mapper does
not silently clamp it; supported-range syntax is covered by mapper assertions.

Important strict-fidelity rule: Xray 26.11 rejects `allowInsecure=true` rather
than honoring the node's `skip-cert-verify=true`. Such fixtures are UNSUPPORTED
for this Xray client mapping, even when their protocol is supported. We do not
silently replace skip-verification with trust in the lab CA or inject a pin from
server-side knowledge. A pin/trust policy must come from elsewhere; this is a
core capability difference, not evidence that the Mihomo node lost a URI field.
Reality authenticates differently, so its fixture's insecure bit is not used.
The mapper's `gaps` records this distinction explicitly. No inference of Reality
server generation/hybrid-key-share support is made from `pbk`, `sid`, or `fp`.

`LAB_MODE=all` (default) runs all stages. `clients` runs only the new native
clients (plus common parsing/config preflight); `reality` selects only Reality
fixtures and runs Mihomo unset/true comparisons. Every mode writes the same
combined-column report; nonexecuted stages remain SKIP/N/A.
