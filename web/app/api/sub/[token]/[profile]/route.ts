import { requireSubToken } from '@/lib/auth';
import { renderBase } from '@/lib/engine/renderer';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listRules } from '@/lib/repos/rulesRepo';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/sub/[token]/[profile]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
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

  const rules = await listRules();
  const rendered = renderBase(base.content, rules);

  return new Response(rendered.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="proxymanager-${profile}.yaml"`,
      'Cache-Control': 'no-store',
      'Profile-Update-Interval': '24',
      'X-Build-Id': rendered.buildId,
    },
  });
});
