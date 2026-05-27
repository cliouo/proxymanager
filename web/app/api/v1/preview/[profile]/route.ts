import { resolveConfig } from '@/lib/engine/resolve';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/preview/[profile]'>;

export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { profile } = await ctx.params;
  if (profile !== 'default') {
    throw ProblemDetailsError.notFound(
      `Profile "${profile}" not configured. Only "default" is supported in MVP.`,
    );
  }

  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.notFound('Base config has not been initialized yet.');
  }

  const [rules, providers, subscriptions, collections] = await Promise.all([
    listRules(),
    listRuleSets(),
    listSubscriptions(),
    listCollections(),
  ]);
  const origin = new URL(request.url).origin;
  const token = process.env.SUB_TOKEN;
  const resolved = await resolveConfig(base.content, rules, subscriptions, collections, {
    providers,
    providerUrlBase: token ? `${origin}/api/rule-providers/${token}` : undefined,
    ignoreFailedSubs: true,
  });

  return Response.json({
    data: {
      content: resolved.content,
      build_id: resolved.buildId,
      anchors_applied: resolved.anchorsApplied,
      unmatched_anchors: resolved.unmatchedAnchors,
      inlined_proxy_count: resolved.inlinedProxyCount,
      node_names: resolved.nodeNames,
      collisions: resolved.collisions,
      subscriptions: resolved.subscriptions,
      pools: resolved.pools,
      warnings: resolved.warnings,
    },
  });
});
