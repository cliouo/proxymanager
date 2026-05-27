import { requireSubToken } from '@/lib/auth';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getRuleSetByName } from '@/lib/services/ruleSetService';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/rule-providers/[token]/[name]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { token, name } = await ctx.params;
  requireSubToken(token);

  const set = await getRuleSetByName(name);
  if (!set) {
    throw ProblemDetailsError.notFound(`Rule set "${name}" not found.`);
  }
  // Remote rule-sets are fetched by mihomo from their own URL; we don't proxy them.
  if (set.source === 'remote') {
    throw ProblemDetailsError.notFound(`Rule set "${name}" is remote and not hosted here.`);
  }

  const contentType =
    set.format === 'yaml' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8';

  return new Response(set.content, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      ETag: `"${set.id}-${set.updated_at}"`,
    },
  });
});
