import { renderBase } from '@/lib/engine/renderer';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';

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

  const [rules, providers] = await Promise.all([listRules(), listRuleSets()]);
  const origin = new URL(request.url).origin;
  const token = process.env.SUB_TOKEN;
  const rendered = renderBase(base.content, rules, {
    providers,
    providerUrlBase: token ? `${origin}/api/rule-providers/${token}` : undefined,
  });

  return Response.json({
    data: {
      content: rendered.content,
      build_id: rendered.buildId,
      anchors_applied: rendered.anchorsApplied,
      unmatched_anchors: rendered.unmatchedAnchors,
    },
  });
});
