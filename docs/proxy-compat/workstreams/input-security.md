# Input safety, cache, and delivery-chain audit

This is a historical workstream snapshot. Integrated status in
`../findings.md` and `../validation.md` supersedes every “open” or “current
worktree” label below.

At this workstream's handoff, IS-001, IS-002, IS-004, IS-005, and IS-008 were
fixed with regression coverage in `web/tests/subscriptions/inputSafety.test.ts`
and `web/tests/engine/baseInputSafety.test.ts`; later integration closed the
remaining accepted findings.

Audit anchor: commit `9596cec88fb17fd67ed7102b625b18bb92e9f68f`
(`9596cec`, 2026-07-15). The worktree was clean at the start of this audit. The
integration agent subsequently started concurrent fixes for PC-001/PC-002 in
`uriToClash.ts`, `subscriptionFetcher.ts`, and `proxyUri.test.ts`; line references
below describe the current worktree after those changes unless a finding is
explicitly labelled “initial baseline”. Function names are the durable anchor.

All dynamic probes used generated hosts, UUIDs, and strings such as
`FAKE_SECRET_DO_NOT_USE`; no real subscription URL, node, token, password, or key
was read or emitted.

## Pipeline traced

```text
local content (schema cap: 4 MiB)
  -> normaliseToClashProxies
  -> rawFromProxies

remote URL
  -> fetch(timeout 15 s, redirect follow)
  -> readCapped(10 MiB) -> fatal UTF-8 TextDecoder
  -> normaliseToClashProxies
  -> rawFromProxies
  -> normalised provider YAML in fetch-cache:<hash>

raw proxies
  -> per-sub operators
  -> either nodeExportService -> providerResponse
  -> or resolveConfig -> append to base -> renderBase -> render cache
     -> public full-config response
```

The fetch cache stores already-normalised provider YAML, not the upstream body.
That makes parser-version invalidation a correctness requirement: a cache hit no
longer has enough information to re-run a changed URI normaliser.

## Current input-format contract observed

These results came from a single in-memory `tsx` probe through
`normaliseToClashProviderYaml`; “accepted” means the current YAML normaliser
returned a provider, not that a fixed Mihomo binary accepted every node.

| Input                                                                  | Current result                                     | Contract note                                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Full Mihomo/Clash YAML with `proxies: [...]`                           | Accepted                                           | Only the array is retained; other top-level keys are discarded.                                  |
| Provider YAML with `proxies: [...]`                                    | Accepted                                           | Array membership is checked, but node structure is not.                                          |
| JSON object `{"proxies":[...]}`                                        | Accepted                                           | This is incidental YAML-parser compatibility, not a general JSON target adapter.                 |
| YAML/JSON single-node object                                           | Rejected                                           | No single-node wrapper is implemented.                                                           |
| Plain URI list                                                         | Accepted                                           | Blank lines and `#`/`//` comment lines are ignored.                                              |
| URI list mixed with non-comment ordinary text                          | Accepted; ordinary text is silently skipped        | See IS-009.                                                                                      |
| Standard or URL-safe base64 URI list/YAML, one layer                   | Accepted                                           | Padding may be omitted; whitespace is removed before decode.                                     |
| Double base64                                                          | Rejected with the generic unsupported-format error | Decode depth is exactly one in the current implementation, but the public error does not say so. |
| JSON5-like flow syntax with unquoted keys/single quotes/trailing comma | Some examples accepted                             | `yaml@2.9.0` accepts this subset as YAML; there is no JSON5 parser or complete JSON5 promise.    |
| Xray `outbounds` JSON                                                  | Rejected                                           | Research-only until a target adapter exists.                                                     |
| sing-box `outbounds` JSON                                              | Rejected                                           | Research-only until a target adapter exists.                                                     |
| Surge/Loon/Quantumult/Stash lines, WireGuard `.conf`                   | Not recognised by this entry point                 | Do not claim support based on YAML/JSON syntax alone.                                            |

Current positive guards:

- Local subscription content is capped at 4 MiB by
  `schemas/subscription.ts:59,103,125`; base updates are capped at 512 KiB by
  `schemas/base.ts:9,21-23`.
- Remote bodies share the fetch timeout with body consumption. `readCapped`
  distinguishes an exact-cap EOF from a subsequent byte, while the subscription
  caller rejects both an oversized declared `Content-Length` and streaming
  overflow before decoding or normalising (`subscriptionFetcher.ts`,
  `safeFetch.ts:readCapped`).
- `yaml@2.9.0` uses a default alias expansion limit of 100 when converting a
  document to JS. This is a useful alias-bomb guard, but it is not a node schema
  validator.
- `noCache=true` correctly skips fetch-cache reads and stale fallback, forces a
  new fetch, skips render-cache reads, and still writes the fresh result
  (`subscriptionFetcher.ts:284-326`, `renderCache.ts:156-180,217-268`).
- Provider responses expose `X-Stale` and `X-Skipped-Members` without exposing
  raw reasons (`providerResponse.ts:16-29`). The public full-config route does
  not have the equivalent guard; see IS-007.
- Render cache entries have a data `config:version`, provider-URL identity,
  freshness window, and `RENDER_CACHE_EPOCH` (`renderCache.ts:50-79,156-176`).
  The current integration worktree also adds `FETCH_CACHE_EPOCH` to the
  normalised-provider cache key and bumps both epochs for the fail-closed URI
  change; runtime cache-payload validation remains open in IS-006.

## Findings summary

| ID     | Suggested severity                   | Status                                                         | Trigger and outcome                                                                                                                       |
| ------ | ------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| IS-001 | P1                                   | Fixed in current worktree; regression covered                  | A valid `10 MiB + 1 byte` upstream body was truncated to 10 MiB, accepted, and could be cached as a partial provider.                     |
| IS-002 | P1                                   | Fixed in current worktree; regression covered                  | Malformed UTF-8 in a byte-sensitive YAML field was replaced with U+FFFD and silently changed the emitted credential.                      |
| IS-003 | P1, promote to P0 after binary proof | Confirmed, open                                                | `proxies: [{name: BROKEN_ONLY_NAME}]` reaches final config with no warning or required-field validation.                                  |
| IS-004 | P1, promote to P0 after binary proof | Fixed for root-shape scope; regression covered                 | A top-level YAML scalar/sequence passed base validation and was served as the final config.                                               |
| IS-005 | P1                                   | Fixed in current worktree; regression covered                  | Negative/fractional traffic header values could be persisted, after which `SubscriptionSchema` rejected the whole subscription row.       |
| IS-006 | P1                                   | Epoch invalidation fixed concurrently; payload validation open | Parser and render epochs now invalidate pre-hardening results. Corrupt cached YAML can still degrade to zero nodes without an error.      |
| IS-007 | P1                                   | Confirmed by code path, open                                   | A per-sub failure is tolerated, cached as a partial full config, and hidden from the public full-config response until TTL/noCache.       |
| IS-008 | P0                                   | Fixed in current worktree; regression covered                  | A YAML syntax error could echo a complete source line containing a password into Problem Details and logs.                                |
| IS-009 | P1                                   | Confirmed, open                                                | Non-comment ordinary lines in a URI subscription are silently ignored when at least one URI succeeds.                                     |
| IS-010 | P2                                   | Confirmed, open                                                | The fallback error lists only part of the actual scheme registry and format wording overstates ambiguous JSON5/base64 behaviour.          |
| IS-011 | P2/advisory                          | Product decision                                               | Any holder of a valid public token can repeatedly request `?noCache=1`, forcing upstream work; valid-token bypasses are not rate-limited. |
| PC-001 | P0                                   | Initial baseline; concurrent integration fix present           | Failed-URI diagnostics retained the first 80 raw URI characters, including credentials.                                                   |
| PC-002 | P1                                   | Initial baseline; concurrent integration fix present           | A successful URI caused sibling URI parse errors to be discarded. IS-006/IS-007 still affect deployment and end-to-end behaviour.         |

## IS-001 — the 10 MiB “cap” silently truncates and accepts

Locations:

- `web/lib/net/safeFetch.ts:readCapped:99-133` returns
  `{ buf, truncated }` and cancels once the buffer is full.
- `web/lib/services/subscriptionFetcher.ts:fetchSubscriptionInternal:339-381`
  destructures only `{ buf }` at line 366, discarding `truncated`, then decodes,
  normalises, and later caches the shortened content.

Executed probe (in-memory generated YAML prefix followed by a YAML comment):

```bash
cd web
./node_modules/.bin/tsx -e '<construct exactly 10*1024*1024 bytes and cap+1; call readCapped and fetchSubscription>'
```

Observed output:

```json
{"bytes":10485760,"readBytes":10485760,"truncated":true,"accepted":true,"proxyCount":1}
{"bytes":10485761,"readBytes":10485760,"truncated":true,"accepted":true,"proxyCount":1}
```

The first row exposes a second boundary bug: the stream branch uses
`value.byteLength >= room`, so a body that is exactly at the limit is also marked
truncated. Simply starting to reject `truncated` would therefore reject a legal
exact-cap body.

Why existing guards do not stop it: the timeout stays active and the reader does
cancel, so resource consumption is bounded, but neither establishes completeness.
Because a valid YAML prefix can be followed by a comment (or the truncation can
land at a line boundary), YAML parsing succeeds and the shortened provider is
indistinguishable downstream. `setFetchCache` then makes it durable.

Recommended change:

1. Make `readCapped` distinguish exact-cap from cap-plus-one, for example by
   reading/probing one extra byte and returning a precise `truncated` flag.
2. Check declared `Content-Length` early when present, but retain the streaming
   check because the header is optional/untrusted.
3. In the subscription fetcher, reject `truncated` with a credential-free 400;
   never normalise or cache the prefix.

Minimal regression set:

- `cap - 1` and exact `cap` succeed with `truncated=false`.
- `cap + 1`, chunked cap-plus-one, and a body with a valid prefix all reject.
- rejection does not call `setFetchCache`; with a prior cache it may take the
  explicitly tested stale-on-error path and marks `stale=true`.

Implementation status (2026-07-15): fixed. `readCapped` now probes EOF after an
exact-cap chunk and reports truncation only after observing an additional
non-empty chunk. `fetchSubscriptionInternal` rejects an oversized declared
length or streaming overflow with the same credential-free 400 before UTF-8
decode, YAML normalisation, or cache insertion. The new test covers exact-cap,
cap-plus-one, declared oversize, and a chunked valid-prefix overflow.

## IS-002 — non-fatal UTF-8 decode silently changes credentials

Location: `subscriptionFetcher.ts:fetchSubscriptionInternal:366-367` uses the
default non-fatal `TextDecoder`; malformed byte sequences become U+FFFD.

Executed fake-byte probe: a provider YAML password `fa<0xff>ke` was returned in
a `Response(Uint8Array)` and passed through `fetchSubscription`.

Observed:

```json
{
  "accepted": true,
  "proxyCount": 1,
  "replacementChar": true,
  "passwordLine": "    password: fa�ke"
}
```

Why guards do not stop it: U+FFFD is legal Unicode and legal YAML, so the YAML
parser and object filters accept the already-corrupted value. The cache stores
the changed password rather than the original bytes.

Recommended change: decode UTF-8 with `{ fatal: true }`, return a sanitized input
error on malformed bytes, and test stale fallback/no-cache semantics. Preserve a
valid Unicode/emoji control case. If non-UTF-8 charsets are intentionally
supported, make charset decoding explicit rather than relying on replacement.

Implementation status (2026-07-15): fixed. Remote subscription bytes are decoded
with `{ fatal: true }`; malformed input returns exactly
`Upstream subscription body is not valid UTF-8`, without including source bytes.
The regression test also preserves a valid emoji/multibyte control case.

## IS-003 — provider nodes have no structural or protocol validation

Locations:

- `subscriptionFetcher.ts:tryExtractProxiesFromYaml:501-511` checks only that
  `proxies` is an array.
- `subscriptionFetcher.ts:filterProxyObjects:110-127` checks only plain-object
  shape; cache parse failures become `[]`.
- `nodeExportService.ts:dedupByName/exportSubscriptionNodes:36-67` requires only a
  string name before serialising a public provider.
- `resolve.ts:resolveConfig:225-228,301-305` requires only a string name before
  appending the unvalidated object to the final config.
- `validator.ts:validateBase:4-49` validates rule references, not proxy objects or
  Mihomo field types.

Executed probe:

```text
local content: proxies:\n  - name: BROKEN_ONLY_NAME
base: a syntactically valid mapping
call: resolveConfig(..., persistSnapshot=false)
```

Observed:

```text
invalid_node_reaches_full_config=true
keys=name
warnings=0
```

Why guards do not stop it: array/object/name checks prevent obvious JS shape
errors but do not require `type`, `server`, `port`, or protocol-specific fields.
No final parse/schema/Mihomo check runs after injection and rendering.

Recommended change: define a deliberate input contract. At minimum validate
common node fields and scalar types before cache/export/injection; then either
validate supported protocol schemas or retain unknown Mihomo types only through
an explicit “YAML passthrough” policy. A rejected node must fail the source or
produce an end-to-end warning, never disappear silently. Wrap every provider in
a minimal full config and run the pinned Mihomo binary before closing severity.

Suggested tests: malformed core fields, non-object entries, unknown types,
per-protocol minimal valid nodes, cache hit/stale hit, source provider, collection
provider, final config, and fixed-Mihomo validation.

## IS-004 — base parser/validator accepts a non-mapping document

Locations:

- `engine/parser.ts:parseBase:32-45` checks only YAML syntax.
- `engine/validator.ts:validateBase:4-49` checks anchors/policies/rule-set
  references only.
- `schemas/base.ts:BaseUpdateRequestSchema:21-23` caps length but does not validate
  root/section shape.
- `services/baseService.ts:parseAndValidate:78-105` therefore permits save when
  there are no orphaned managed rules.
- `engine/resolve.ts:resolveConfig:154-176` also checks only syntax; with no
  injected subscription a scalar/sequence passes unchanged to `renderBase`.

Executed probe:

```text
parseBase("hello") -> valid ParsedBase with built-in policies
resolveConfig("hello", [], [], [], [], {persistSnapshot:false}) -> "hello\n"
parseBase("[]") -> valid ParsedBase
resolveConfig("[]", ...) -> "[]\n"
```

Why guards do not stop it: syntactic YAML validity is weaker than a Mihomo config
mapping. If subscriptions are later injected, `appendProxies` may replace a
wrong-typed `proxies` field or fail against a scalar root; without subscriptions,
the invalid root is served directly.

Recommended change: require a mapping root in both save-time parsing and the
render-time defense. Validate known section shapes (`proxies`/`proxy-groups` as
sequences, provider maps, `rules` as a sequence/managed marker contract) instead
of silently treating wrong types as empty. Add save-route, legacy-stored-base,
render, reparse, and pinned-Mihomo tests.

Implementation status (2026-07-15): fixed for the assigned root-shape boundary.
`parseBaseDocument` is now the shared parser for `parseBase` and
`resolveConfig`; it accepts only a YAML mapping root and rejects sequence,
scalar, null, and empty roots with the fixed message
`Invalid base YAML: root must be a mapping`. This covers both candidate saves
through `parseAndValidate` and legacy stored content reaching the render path.
Known-section shape validation and pinned-Mihomo load validation remain separate
follow-up work.

## IS-005 — untrusted traffic metadata can poison the stored subscription row

Locations:

- `subscriptionFetcher.ts:parseTrafficHeader:384-401` accepts every finite
  number, including negatives and fractional expiry values.
- `schemas/subscription.ts:SubscriptionTrafficSchema:25-30` requires nonnegative
  counters and an integer expiry.
- refresh persists the parsed traffic through
  `subscriptions/[id]/refresh/route.ts:28-45` and
  `subscriptionService.ts:recordSubscriptionSync:111-129` without a runtime
  schema check.
- On the next read, `subscriptionsRepo.normalise` rejects the whole row when its
  `last_traffic` violates the schema.

Executed probe:

```text
header = "upload=-1; download=2; total=3; expire=4.5"
parseTrafficHeader(header)
SubscriptionSchema.safeParse(rowWithThatLastTraffic)
```

Observed:

```text
traffic={"upload":-1,"download":2,"total":3,"expire":4.5}
stored_row_rejected=true
issues=last_traffic.upload nonnegative; last_traffic.expire integer
```

Why guards do not stop it: `Number.isFinite` is not the same contract as the Zod
schema, and TypeScript types do not validate the upstream HTTP header at runtime.

Recommended change: build the four-field object, run
`SubscriptionTrafficSchema.safeParse`, and ignore/reject invalid metadata without
failing or corrupting an otherwise valid node subscription. Test negative,
fractional, overflow/unsafe, duplicate, missing, and valid zero values through
fetch, refresh persistence, cache hit, and provider response.

Implementation status (2026-07-15): fixed at the parser/persistence-schema
boundary. Only `upload`, `download`, `total`, and `expire` are considered;
unknown-only headers return no metadata, missing known fields retain zero
defaults, and the complete object must pass `SubscriptionTrafficSchema` before it
can be returned for persistence. Regression coverage proves the original
negative/fractional trigger no longer makes a `SubscriptionSchema` row invalid.

## IS-006 — cache epoch fixed; runtime payload validation remains

Locations:

- `fetchCacheRepo.ts:FETCH_CACHE_EPOCH/buildCacheKey` now includes a parser epoch
  in the cache identity (concurrent integration fix).
- `subscriptionFetcher.ts:resolveSubscriptionRaw:278-325` trusts fresh/stale
  cached normalised YAML without re-running the URI normaliser.
- `subscriptionFetcher.ts:extractProxyObjects:117-127` converts malformed cached
  YAML or a wrong shape into an empty successful list.
- `renderCache.ts:RENDER_CACHE_EPOCH` was concurrently bumped with the fetch
  epoch, invalidating already-rendered partial full configs.

The original deployment trigger was a mixed URI list cached before PC-002, then
served after deploying fail-closed parsing. The concurrent `FETCH_CACHE_EPOCH=2`
and `RENDER_CACHE_EPOCH=10` changes close that migration path.

Residual trigger: a structurally corrupt current-epoch Redis entry is still
trusted by `resolveSubscriptionRaw`; malformed YAML or a wrong shape becomes an
empty object list in `extractProxyObjects`. Epochs identify parser semantics but
do not runtime-validate entry fields or provider content.

Recommended change:

- Keep bumping the fetch and render epochs together for future
  parse/normalisation/output semantic changes (implemented and documented in
  `web/AGENTS.md`).
- Runtime-validate cache entry fields and cached provider structure. A corrupt
  fresh entry should be treated as a miss and deleted/refetched; a corrupt stale
  entry must not become a successful zero-node source.
- Test old/absent epoch, malformed content, wrong proxy count, future/invalid
  `fetched_at`, fresh hit, stale fallback, and `noCache` across both cache layers.

## IS-007 — partial full configs are hidden and cached

Locations:

- `resolve.ts:resolveConfig:176-237` defaults to tolerating rejected subscriptions
  and records the raw error only in `subStatuses`.
- `renderCache.ts:renderProfileConfig:217-260` explicitly passes
  `ignoreFailedSubs:true`, includes failed sources in the participating set, and
  caches the partial result for the computed `freshForMs`.
- `app/api/sub/[token]/[profile]/route.ts:28-65` returns the partial YAML but no
  `X-Skipped-Subscriptions`/`X-Stale` summary; it discards
  `resolved.subscriptions` and warnings.
- By contrast, node-provider delivery exposes `X-Stale` and
  `X-Skipped-Members` (`providerResponse.ts:16-29`).

Minimal reproduction test: make source A reject without a stale entry and source
B succeed; render the profile twice. Current expected observation is first
`cache=miss` with only B, second `cache=hit` without retrying A, even if A's mock
has recovered. The public response is 200 with only node-count/cache headers.

Why guards do not stop it: status is preserved for authenticated preview/snapshot
consumers, but the public client consuming the actual config cannot see it.
`noCache=1` repairs it only when a caller knows to request it.

Recommended product choice: either fail closed for the public full-config route,
or make partial delivery explicit and short-lived. At minimum do not cache a
result containing source errors for the normal source TTL, schedule a short retry,
and return credential-free skipped/stale counts on both 200 and 304. Add a
route-level end-to-end test; unit tests that inspect `resolved.subscriptions` are
not sufficient.

## IS-008 — base YAML diagnostics can echo credentials

Locations:

- `engine/parser.ts:parseBase:35-38` embeds `doc.errors[0].message`; YAML's pretty
  error includes a source code frame.
- `services/baseService.ts:parseAndValidate:83-88` wraps the message in explicit
  Problem Details, so the production handler's unhandled-error redaction does
  not apply (`http/handler.ts:23-47`).
- `resolve.ts:resolveConfig:162-165` also embeds the raw YAML error; production
  hides this from the HTTP body but logs the unhandled error, including its source
  line.

Executed fake-secret probe: an invalid flow mapping kept
`password: FAKE_SECRET_DO_NOT_USE` on the same line as the syntax error.

Observed:

```text
base_error_leak=true
Invalid YAML: ... { name: x, type: trojan, password: FAKE_SECRET_DO_NOT_USE, broken: [ }
```

Why guards do not stop it: body-size limits and YAML syntax detection work, but
pretty diagnostics are not secret-safe. Problem Details passes explicitly
constructed details through verbatim.

Recommended change: expose only stable error code plus line/column (not the code
frame/source text), and ensure logs/snapshots never serialize raw YAML diagnostics.
Use a generated fake secret in parser, base validate/save route, render route, and
log-spy tests.

Implementation status (2026-07-15): fixed with a stricter fixed-message
contract. YAML syntax failures now become `Invalid base YAML`; yaml's diagnostic
object/code frame is not retained as `BaseParseError.cause`. `parseAndValidate`
returns the same text as a 422, while the legacy render path throws only that
sanitized error. Regression tests place `FAKE_SECRET_DO_NOT_USE` on the malformed
source line and assert it is absent at all three boundaries.

## IS-009 — ordinary text lines in URI lists are silently skipped

Locations:

- `uriToClash.ts:parseProxyUriList:95-100` continues when a non-comment line has
  no URI scheme and therefore creates neither a proxy nor an error.
- `subscriptionFetcher.ts:normaliseToClashProxies:480-493` can only fail closed on
  the `errors` it receives.

Executed probe:

```text
NOTICE banner
ss://<generated fake userinfo>@example.invalid:8388#ok
```

Observed: accepted with `proxyCount=1`; the ordinary line appears in neither YAML
nor diagnostics. The concurrent PC-002 fix correctly rejects recognised URI
lines that fail parsing, but does not cover this line class.

Recommended change: after the input has been classified as a URI list, every
nonblank/non-comment line must be either one recognised URI or an explicit error.
If banner lines are an intentional compatibility feature, define a narrow,
tested banner grammar and carry a warning; do not ignore arbitrary text.

## IS-010 — support-list and format diagnostics drift

`uriToClash.ts:KNOWN_SCHEMES:33-51` currently has 17 scheme spellings. The generic
message in `subscriptionFetcher.ts:496-498` lists only a subset and omits, among
others, `hysteria://`, `hy2://`, `anytls://`, `wireguard://`, `wg://`, `socks://`,
and `https://`. It also says “base64 variants” without stating the one-layer
decode limit, while a YAML-readable subset of JSON5-like syntax is accepted
accidentally.

Recommended change: generate supported-scheme diagnostics from the parser
registry and document exact container recognition/decode depth separately from
protocol support. Tests should assert registry/error parity.

## IS-011 — public noCache is an authenticated amplification switch

The public full/source/collection routes accept `?noCache=1`. A valid token holder
can bypass both render and fetch caches and force up to eight concurrent upstream
requests per render. `guardSubToken` rate-limits failed token guesses, not repeated
valid-token bypasses. Existing 15-second timeout, 10 MiB body bound, and concurrency
limit constrain each request but not request frequency.

This is an advisory/product decision, not a confirmed vulnerability in a
single-user deployment. Consider a small per-resource/IP bypass rate limit or
admin-only refresh endpoint while keeping normal polling cacheable. Add a test
that ordinary valid-token traffic is unaffected.

## Initial-baseline issues already being integrated

### PC-001 — failed URI diagnostics retained credentials

Initial `parseProxyUriList` stored `truncate(line)`; a fake Trojan password was
present in the thrown normaliser message. During this audit, the integration
agent changed diagnostics to `line N (scheme://)` and made URL-constructor errors
generic. Re-run secret-absence tests at every sink, including `last_error`, stale
reasons, collection member errors, Problem Details, snapshot/cache, and logs.

### PC-002 — a successful sibling hid failed URI lines

Initial `normaliseToClashProxies` returned immediately when `proxies.length > 0`,
before inspecting `errors`. The integration agent changed it to reject any
recognised URI-line failure. Deployment is incomplete without IS-006 cache epoch
invalidation, and end-to-end full-config behaviour still needs the IS-007 policy.

## Verification run in this workstream

Existing targeted suite:

```bash
cd web
npm test -- tests/subscriptions/fetcher.test.ts \
  tests/subscriptions/staleFallback.test.ts \
  tests/subscriptions/objectPipeline.test.ts \
  tests/subscriptions/nodeExport.test.ts \
  tests/engine/parser.test.ts \
  tests/engine/validator.test.ts \
  tests/engine/integration.test.ts \
  tests/engine/renderCache.test.ts \
  tests/engine/resolveParallel.test.ts
```

Observed: 9 files passed, 76 tests passed. This proves the existing contracts still
pass; it does not cover the confirmed probes above. No Mihomo/Xray/sing-box binary
was present on `PATH`, so loadability promotion to P0 remains pending the pinned
binary workstream.

Implementation verification (2026-07-15):

```bash
cd web
npm test -- tests/subscriptions/inputSafety.test.ts \
  tests/subscriptions/fetcher.test.ts \
  tests/subscriptions/staleFallback.test.ts \
  tests/subscriptions/objectPipeline.test.ts \
  tests/subscriptions/nodeExport.test.ts
npm run typecheck
```

Observed after the fixes: 5 files / 42 tests passed; `tsc --noEmit` passed. Before
the implementation, the isolated new test had 7 failures out of 9, directly
demonstrating all three original behaviours rather than merely exercising the
fixed path.

Second implementation batch verification (2026-07-15):

```bash
cd web
npm test -- tests/engine/baseInputSafety.test.ts \
  tests/engine/parser.test.ts \
  tests/engine/integration.test.ts \
  tests/engine/resolve.test.ts \
  tests/engine/resolveParallel.test.ts \
  tests/engine/renderer.test.ts \
  tests/engine/validator.test.ts \
  tests/engine/rulesBlock.test.ts \
  tests/engine/ruleProviders.test.ts
npm run typecheck
```

Observed after the base fixes: 9 files / 115 tests passed; `tsc --noEmit` passed.
Before implementation, the isolated 12-test safety file had 10 failures: four
parser root shapes, parser/save/render credential exposure, and save/render
non-mapping acceptance.

Coverage gaps in the current tests:

- No explicit assertion yet that an oversized fresh fetch does not call
  `setFetchCache`, or that this exact error selects a prior stale entry; the
  shared stale-on-error tests cover the generic rejection path.
- No URI ordinary-text, secret-at-every-error-sink, double-base64 contract, YAML
  alias/tag, or format-classification table test.
- No cache schema epoch/corrupt entry/future timestamp test.
- No route-level refresh/provider-response test for malformed traffic metadata;
  parser-to-persisted-schema compatibility is covered directly.
- No provider-node schema. Base mapping-root and credential-safe errors are now
  covered at parser, service, and resolve boundaries, but there is no direct
  PUT/validate HTTP-route or log-spy test and no pinned-Mihomo oracle.
- Node export tests mock the fetcher; no provider HTTP response test covers 200,
  304, stale, skipped members, invalid nodes, and sanitized errors together.
- Resolve tests assert internal failure status, but no public full-config test
  asserts fail-closed/explicit-partial behaviour and render-cache retry.
- The parse/validate/render integration test has no subscription injection and no
  fixed-Mihomo oracle.

## Proposed implementation ownership, after coordinator approval

To minimize overlap, prefer isolated security tests where possible.

| Concern                                       | Proposed source files                                                                                         | Proposed tests                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Body completeness + UTF-8 + traffic header    | Implemented in `web/lib/net/safeFetch.ts`, `web/lib/services/subscriptionFetcher.ts`                          | Added `web/tests/subscriptions/inputSafety.test.ts`     |
| Fetch cache epoch/runtime validation          | `web/lib/repos/fetchCacheRepo.ts`, `web/lib/services/subscriptionFetcher.ts`, `web/lib/engine/renderCache.ts` | `staleFallback.test.ts`, `renderCache.test.ts`          |
| Provider/node validation                      | a new schema/helper plus `subscriptionFetcher.ts`, `nodeExportService.ts`, `resolve.ts`                       | new table-driven provider/full-chain test               |
| Base mapping root + sanitized YAML errors     | Implemented in `engine/parser.ts`, `engine/resolve.ts`, `services/baseService.ts`                             | Added `tests/engine/baseInputSafety.test.ts`            |
| Partial/stale public contract                 | `engine/renderCache.ts`, public profile route, `providerResponse.ts` if headers are shared                    | `renderCache.test.ts`, new route/response test          |
| URI ordinary-line classification/support text | `uriToClash.ts`, `subscriptionFetcher.ts`                                                                     | `proxyUri.test.ts` only after current owner releases it |

Implementation ownership was granted only for IS-001/IS-002/IS-005 and then
IS-004/IS-008. This workstream did not edit `fetchCacheRepo.ts`,
`renderCache.ts`, `uriToClash.ts`, `proxyUri.test.ts`, or the parent compatibility
documents.
