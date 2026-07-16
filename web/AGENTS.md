<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Proxy parser cache invariant

When proxy URI parsing or subscription normalisation changes the emitted node
set or fields, bump both `FETCH_CACHE_EPOCH` in
`lib/repos/fetchCacheRepo.ts` and `RENDER_CACHE_EPOCH` in
`lib/engine/renderCache.ts`. The fetch cache stores already-normalised provider
YAML, and the render cache can otherwise return an older full config before the
fetch layer runs.

## Save-time rendered-config invariant

Any profile-scoped base, rule, or proxy-group mutation must preflight the exact
final rendered config without writing fetch/render caches or accepting stale
upstream data, then commit against the same planning/config version. New
mutation paths that can change rendered output must preserve this invariant and
return structured, credential-free validation issues.
