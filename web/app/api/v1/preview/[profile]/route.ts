import { renderProfileConfig } from '@/lib/engine/renderCache';
import { withProblemDetails } from '@/lib/http/handler';

export const dynamic = 'force-dynamic';
// P3-18: the final-config preview runs the full resolve pipeline (upstream
// fetches + render); give it an explicit ceiling over the platform default.
export const maxDuration = 60;

type Ctx = RouteContext<'/api/v1/preview/[profile]'>;

export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { profile } = await ctx.params;
  // Any profile renders by name — renderProfileConfig binds its source and
  // 404s an unknown name (see lib/engine/renderCache).
  const origin = new URL(request.url).origin;
  const token = process.env.SUB_TOKEN;
  // Data loading + resolveConfig now live behind the render cache — when
  // nothing changed since the last render, this is a single Redis MGET.
  const { resolved, cache } = await renderProfileConfig(profile, {
    providerUrlBase: token ? `${origin}/api/rule-providers/${token}` : undefined,
  });

  return Response.json(
    {
      data: {
        content: resolved.content,
        build_id: resolved.buildId,
        anchors_applied: resolved.anchorsApplied,
        unmatched_anchors: resolved.unmatchedAnchors,
        inlined_proxy_count: resolved.inlinedProxyCount,
        proxy_group_count: resolved.proxyGroupCount,
        node_names: resolved.nodeNames,
        nodes_by_sub: resolved.nodesBySub,
        collisions: resolved.collisions,
        subscriptions: resolved.subscriptions,
        warnings: resolved.warnings,
      },
    },
    { headers: { 'X-Render-Cache': cache } },
  );
});
