import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import {
  getSubscription,
  nowSeconds,
  recordSubscriptionError,
  recordSubscriptionSync,
} from '@/lib/services/subscriptionService';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]/refresh'>;

/**
 * Force-refresh a subscription. Bypasses the fetch cache (noCache=true)
 * because the user explicitly asked to re-sync; otherwise the call would
 * be a no-op when the previous fetch is still within ttl_ms.
 */
export const POST = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const configVersion = await getConfigVersion();
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  if (!sub.enabled) {
    throw ProblemDetailsError.unprocessable(`Subscription "${sub.name}" is disabled.`);
  }

  let traffic;
  let proxyCount;
  try {
    ({ traffic, proxyCount } = await resolveSubscriptionContent(sub, {
      noCache: true,
      ordinalConfigVersion: configVersion,
    }));
  } catch (err) {
    // P3-8: record why the refresh failed so the status badge can surface it.
    const msg =
      err instanceof ProblemDetailsError
        ? (err.problem.detail ?? err.problem.title)
        : err instanceof Error
          ? err.message
          : String(err);
    await recordSubscriptionError(id, msg, configVersion).catch(() => undefined);
    throw err;
  }
  const updated = await recordSubscriptionSync(id, nowSeconds(), traffic, configVersion);

  return Response.json({ data: updated, meta: { proxyCount } });
});
