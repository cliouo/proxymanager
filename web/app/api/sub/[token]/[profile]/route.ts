import { requireSubToken } from '@/lib/auth';
import { expandCollections } from '@/lib/engine/collectionExpander';
import { renderBase } from '@/lib/engine/renderer';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';

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

  // Step 1 — inline pm-inline-collections subscriptions into proxies:
  const noCache = new URL(request.url).searchParams.get('noCache') === '1';
  const { expandedContent, summary } = await expandCollections(base.content, {
    ignoreFailedSubs: true,
    noCache,
  });

  // Step 2 — splice rules into anchored slots + inject the referenced
  // rule-providers (managed library → base.yaml at render time).
  const [rules, providers] = await Promise.all([listRules(), listRuleSets()]);
  const origin = new URL(request.url).origin;
  const rendered = renderBase(expandedContent, rules, {
    providers,
    providerUrlBase: `${origin}/api/rule-providers/${token}`,
  });

  return new Response(rendered.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="proxymanager-${profile}.yaml"`,
      'Cache-Control': 'no-store',
      'Profile-Update-Interval': '24',
      'X-Build-Id': rendered.buildId,
      'X-Inlined-Proxy-Count': String(summary.inlinedProxyCount),
    },
  });
});
