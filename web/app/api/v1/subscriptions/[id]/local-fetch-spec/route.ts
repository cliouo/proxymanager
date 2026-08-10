import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getSubscription } from '@/lib/services/subscriptionService';
import {
  effectiveFetchIdentityRevision,
  effectiveSubscriptionCustomHeaders,
  subscriptionUserAgent,
} from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]/local-fetch-spec'>;

/** Authenticated, no-store fetch inputs used only by the page or trusted extension background. */
const getWithProblemDetails = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  try {
    const { id } = await ctx.params;
    const subscription = await getSubscription(id);
    if (!subscription) throw ProblemDetailsError.notFound(`Subscription ${id} not found.`);
    if (subscription.kind !== 'remote' || !subscription.url) {
      throw ProblemDetailsError.unprocessable('只有远程订阅可以从本地网络更新。');
    }
    return Response.json({
      data: {
        subscriptionId: subscription.id,
        url: subscription.url,
        userAgent: subscriptionUserAgent(subscription),
        customHeaders: effectiveSubscriptionCustomHeaders(subscription) ?? {},
        updatedAt: subscription.updated_at ?? 0,
        fetchIdentityRevision: effectiveFetchIdentityRevision(subscription),
      },
    });
  } catch (error) {
    if (error instanceof ProblemDetailsError) throw error;
    console.error('[subscription-local-fetch-spec] unexpected failure');
    throw ProblemDetailsError.internal();
  }
});

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const response = await getWithProblemDetails(request, ctx);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
