import { requireSubToken } from '@/lib/auth';
import { resolveConfig } from '@/lib/engine/resolve';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/sub/[token]/[profile]'>;

export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, profile } = await ctx.params;
  requireSubToken(token);

  if (profile !== 'default') {
    throw ProblemDetailsError.notFound(
      `Profile "${profile}" not configured. Only "default" is supported in MVP.`,
    );
  }

  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.notFound('Base config has not been initialized yet.');
  }

  const noCache = new URL(request.url).searchParams.get('noCache') === '1';
  const [rules, providers, subscriptions, proxyGroups, templates, collections] = await Promise.all([
    listRules(),
    listRuleSets(),
    listSubscriptions(),
    listProxyGroups(),
    listProxyGroupTemplates(),
    listCollections(),
  ]);
  const origin = new URL(request.url).origin;
  const resolved = await resolveConfig(
    base.content,
    rules,
    subscriptions,
    proxyGroups,
    templates,
    {
      providers,
      providerUrlBase: `${origin}/api/rule-providers/${token}`,
      ignoreFailedSubs: true,
      noCache,
      collections,
    },
  );

  return new Response(resolved.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="proxymanager-${profile}.yaml"`,
      'Cache-Control': 'no-store',
      'Profile-Update-Interval': '24',
      'X-Build-Id': resolved.buildId,
      'X-Inlined-Proxy-Count': String(resolved.inlinedProxyCount),
    },
  });
});
