import { resolveConfig } from '@/lib/engine/resolve';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
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

  const [rules, providers, subscriptions, proxyGroups, templates, collections, profileRecord] =
    await Promise.all([
      listRules(),
      listRuleSets(),
      listSubscriptions(),
      listProxyGroups(),
      listProxyGroupTemplates(),
      listCollections(),
      getProfileByName(profile),
    ]);
  const origin = new URL(request.url).origin;
  const token = process.env.SUB_TOKEN;
  const resolved = await resolveConfig(
    base.content,
    rules,
    subscriptions,
    proxyGroups,
    templates,
    {
      providers,
      providerUrlBase: token ? `${origin}/api/rule-providers/${token}` : undefined,
      ignoreFailedSubs: true,
      collections,
      // Profile binding (Phase 1). When no profile record exists yet (pre-init),
      // falls through to "every enabled sub" — backward-compat.
      boundSource: profileRecord?.source,
    },
  );

  return Response.json({
    data: {
      content: resolved.content,
      build_id: resolved.buildId,
      anchors_applied: resolved.anchorsApplied,
      unmatched_anchors: resolved.unmatchedAnchors,
      inlined_proxy_count: resolved.inlinedProxyCount,
      proxy_group_count: resolved.proxyGroupCount,
      node_names: resolved.nodeNames,
      collisions: resolved.collisions,
      subscriptions: resolved.subscriptions,
      warnings: resolved.warnings,
    },
  });
});
