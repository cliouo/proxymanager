import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import { getSubscription, projectSubscriptionAdminView } from '@/lib/services/subscriptionService';
import { getSubscriptionFetchHealth } from '@/lib/repos/subscriptionFetchHealthRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { effectiveSubscriptionRefreshMode } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]/refresh'>;

/**
 * Force-refresh a subscription (P-FFP v2 I14). Bypasses the fetch cache
 * (noCache=true) because the user explicitly asked to re-sync; otherwise the
 * call would be a no-op when the previous fetch is still within ttl_ms.
 *
 * EXACT snapshot sequence: getConfigVersion once, getSubscription once,
 * validate existence and enabled state, force resolve with noCache true and
 * recordHealth true, getConfigVersion once again, getSubscription once again,
 * then project that SECOND captured row directly. There is NO
 * getSubscriptionAdminView helper call and NO third definition read; a
 * missing second row returns 404 rather than falling back to the old row.
 * A captured remote row performs exactly ONE health read and fingerprint
 * joins it to that same object; a captured local row performs ZERO health
 * reads and omits policy and health. A version move does not 412 the
 * advisory refresh — it returns the captured current row. Refresh never
 * writes a definition.
 */
export const POST = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const configVersion = await getConfigVersion();
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  if (!sub.enabled) {
    throw ProblemDetailsError.unprocessable(`Subscription "${sub.name}" is disabled.`);
  }
  if (sub.kind === 'remote' && effectiveSubscriptionRefreshMode(sub) === 'manual') {
    throw ProblemDetailsError.unprocessable(
      '该订阅由手动内容维护，请使用“手动更新”导入新内容，或先改回平台自动拉取。',
    );
  }

  const { proxyCount } = await resolveSubscriptionContent(sub, {
    noCache: true,
    ordinalConfigVersion: configVersion,
    recordHealth: true,
  });

  // Recheck the generation and CAPTURE the second row: the view is projected
  // from this exact object (no helper reread, no old-row fallback).
  await getConfigVersion();
  const current = await getSubscription(id);
  if (!current) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);

  const view =
    current.kind === 'remote' && effectiveSubscriptionRefreshMode(current) === 'server-auto'
      ? projectSubscriptionAdminView(current, await getSubscriptionFetchHealth(current.id))
      : projectSubscriptionAdminView(current);

  return Response.json({ data: view, meta: { proxyCount } });
});
