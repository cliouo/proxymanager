import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { fetchSubscription } from '@/lib/services/subscriptionFetcher';
import {
  getSubscription,
  nowSeconds,
  recordSubscriptionSync,
} from '@/lib/services/subscriptionService';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]/refresh'>;

export const POST = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sub = await getSubscription(id);
  if (!sub) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
  if (!sub.enabled) {
    throw ProblemDetailsError.unprocessable(`Subscription "${sub.name}" is disabled.`);
  }

  const { traffic, proxyCount } = await fetchSubscription(sub.url, {
    userAgent: sub.ua_override,
  });

  const updated = await recordSubscriptionSync(id, nowSeconds(), traffic);

  return Response.json({ data: updated, meta: { proxyCount } });
});
