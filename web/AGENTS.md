<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Proxy parser cache invariant

When proxy URI parsing or subscription normalisation changes the emitted node
set or fields, bump `FETCH_CACHE_EPOCH` in
`lib/repos/fetchCacheRepo.ts`. The fetch cache stores already-normalised provider
YAML. Full profile/device configs are rebuilt on every request; do not introduce
an independent render cache that can hide a refreshed subscription body.

## Save-time rendered-config invariant

Any profile-scoped base, rule, proxy-group, or subscription mutation must
preflight the exact final rendered config without writing fetch/render caches,
fetch health, resolved snapshots, or ordinal state, then commit against the same
planning/config version. A remote source may use only a validated retained cache
when its `fetch_failure_policy` permits it; a failed collection member may be
skipped only under that same tolerant policy and only when the final rendered
config still validates. Direct sources, local sources, `fail-closed`, and
`noCache` remain fail-closed. New mutation paths that can change rendered output
must preserve this invariant and return structured, credential-free validation
issues.

In the final active top-level rule sequence, `MATCH` is terminal and must be the
global last rule. Same-anchor rendering and rank normalization keep ordinary
rules before active `MATCH`; the final rendered-config validator remains the
single fail-closed gate for cross-anchor, batch, update, explicit-rank, and
legacy candidates. Disabled `MATCH` records are parked and do not terminate the
active sequence.

Device patches and device-scoped feature mutations must derive their complete
candidate and write set from the same version-bracketed device snapshot, pass
the shared preflight gate, and commit with config-version CAS. Feature secrets
must never appear in public device APIs, previews, audit snapshots, errors, or
migration output.

## Shared subscription mutation invariant

A profile-scoped action must not rewrite a subscription used by another profile
unless it preflights every consuming profile against the same candidate and
configuration version. Narrow recovery actions that only plan one profile must
reject shared sources before writing.

## Distribution identity and audit invariants

Resource-scoped distribution credentials bind a resource type and stable ID.
Once a caller authenticates or resolves a Profile ID, every subsequent shared,
device, preview, cache-hit and conditional-304 read must preserve that identity
via `expectedProfileId`; re-resolving a mutable name must never authorize a new
owner. Public name resolution must project identity metadata inside Redis before
authentication, including for legacy inline bodies; fetch full records only by
the authenticated ID afterward.

Audited mutations plan one preflighted configuration CAS and commit core events,
undo links and any idempotency receipt in that same atomic operation. Retention
and advisory taxonomy writes cannot turn committed success into a failed request.
Keep audit snapshots as original JSON strings: Redis cjson re-encoding changes
empty arrays into objects. An operation receipt fingerprint must include scope,
scenario, operation and payload when several actions share one route.
