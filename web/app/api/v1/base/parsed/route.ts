import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { renderProfileConfig } from '@/lib/engine/renderCache';
import { extractStructured } from '@/lib/engine/structured';
import { resolveScopeProfileName } from '@/lib/profileScope';

export const dynamic = 'force-dynamic';

/**
 * Structured read of the resolved config. Returns proxies + proxy-groups
 * in enough detail to power scenario UIs (chained-proxy in particular),
 * with subscription-injected nodes included — so what the picker shows
 * matches what Mihomo will see at /api/sub/{token}/{profile} time.
 *
 * Sub fetch failures are tolerated; the partial view is surfaced in the
 * `resolve.subscriptions` summary alongside any `warnings` (e.g. legacy
 * `pm-inline-collections` detected).
 */
export const GET = withProblemDetails(async (request: Request) => {
  // Scope to the active editing profile (chained-proxy UI etc. read this).
  // No providerUrlBase here (matches the old direct resolveConfig call —
  // the renderer falls back to its placeholder host). The render cache keys
  // identity on that, so this route shares hits with other no-base renders.
  const { resolved, baseEtag, baseUpdatedAt, cache } = await renderProfileConfig(
    resolveScopeProfileName(request),
    {
      missingBaseError: () =>
        ProblemDetailsError.unprocessable('Base config has not been initialized.'),
    },
  );
  // extractStructured stays at the route layer — it's a cheap projection of
  // the cached content, not worth bloating the cache entry with.
  const structured = extractStructured(resolved.content);
  return Response.json(
    {
      data: {
        ...structured,
        etag: baseEtag,
        updated_at: baseUpdatedAt,
        resolve: {
          buildId: resolved.buildId,
          inlinedProxyCount: resolved.inlinedProxyCount,
          proxyGroupCount: resolved.proxyGroupCount,
          nodeNames: resolved.nodeNames,
          collisions: resolved.collisions,
          subscriptions: resolved.subscriptions,
          warnings: resolved.warnings,
        },
      },
    },
    { headers: { 'X-Render-Cache': cache } },
  );
});
