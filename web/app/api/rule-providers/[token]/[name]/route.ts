import { findDistributionIdentity } from '@/lib/repos/distributionIdentityRepo';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { guardSubToken } from '@/lib/http/subGuard';
import { getRuleSet } from '@/lib/repos/ruleSetsRepo';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/rule-providers/[token]/[name]'>;

export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, name } = await ctx.params;

  const meta = await findDistributionIdentity('rule-set', name);
  await guardSubToken(
    request,
    token,
    meta ? { type: 'rule-set', id: meta.id, tokenVersion: meta.token_version } : undefined,
  );
  if (!meta) {
    throw ProblemDetailsError.notFound(`Rule set "${name}" not found.`);
  }
  // Remote rule-sets are fetched by mihomo from their own URL; we don't proxy them.
  if (meta.source === 'remote') {
    throw ProblemDetailsError.notFound(`Rule set "${name}" is remote and not hosted here.`);
  }

  const set = await getRuleSet(meta.id);
  if (!set) throw ProblemDetailsError.notFound(`Rule set "${name}" not found.`);

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
