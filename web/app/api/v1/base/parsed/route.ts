import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveConfig } from '@/lib/engine/resolve';
import { extractStructured } from '@/lib/engine/structured';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';

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
export const GET = withProblemDetails(async () => {
  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.unprocessable('Base config has not been initialized.');
  }
  const [rules, providers, subscriptions, collections] = await Promise.all([
    listRules(),
    listRuleSets(),
    listSubscriptions(),
    listCollections(),
  ]);
  const resolved = await resolveConfig(base.content, rules, subscriptions, collections, {
    providers,
    ignoreFailedSubs: true,
  });
  const structured = extractStructured(resolved.content);
  return Response.json({
    data: {
      ...structured,
      etag: base.etag,
      updated_at: base.updated_at,
      resolve: {
        buildId: resolved.buildId,
        inlinedProxyCount: resolved.inlinedProxyCount,
        nodeNames: resolved.nodeNames,
        collisions: resolved.collisions,
        subscriptions: resolved.subscriptions,
        pools: resolved.pools,
        warnings: resolved.warnings,
      },
    },
  });
});
