import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { safeFetchText } from '@/lib/net/safeFetch';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { getRuleSet } from '@/lib/services/ruleSetService';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/rule-sets/[id]/localize'>;

/**
 * Convert a remote rule-set to platform-hosted: fetch its URL server-side
 * (SSRF-guarded) and store the content as a local rule-set. yaml/text only —
 * mrs is binary and can't be hosted as text. Audited + undoable via the
 * rule-provider scenario.
 */
export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const set = await getRuleSet(id);
  if (!set) throw ProblemDetailsError.notFound(`Rule set ${id} not found.`);
  if ((set.source ?? 'local') !== 'remote' || !set.url) {
    throw ProblemDetailsError.unprocessable('该规则集不是带 url 的外部规则集，无需转换。');
  }
  if (set.format === 'mrs') {
    throw ProblemDetailsError.unprocessable('mrs 为二进制格式，无法转为本地文本托管。');
  }

  const fetched = await safeFetchText(set.url, { maxBytes: 2_000_000 });
  const res = await dispatch({
    scenario: 'rule-provider',
    op: 'patch',
    payload: { id, patch: { source: 'local', content: fetched.text, url: '' } },
    actor: resolveActor(request),
  });
  return Response.json({ data: res.data, meta: { bytes: fetched.bytes } });
});
