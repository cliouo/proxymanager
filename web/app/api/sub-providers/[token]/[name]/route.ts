import { requireSubToken } from '@/lib/auth';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { fetchSubscription } from '@/lib/services/subscriptionFetcher';
import { getSubscriptionByName } from '@/lib/services/subscriptionService';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/sub-providers/[token]/[name]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { token, name } = await ctx.params;
  requireSubToken(token);

  const sub = await getSubscriptionByName(name);
  if (!sub || !sub.enabled) {
    throw ProblemDetailsError.notFound(`Subscription "${name}" not found or disabled.`);
  }

  const { yaml, traffic } = await fetchSubscription(sub.url, { userAgent: sub.ua_override });

  const headers: Record<string, string> = {
    'Content-Type': 'text/yaml; charset=utf-8',
    'Cache-Control': 'no-store',
    'Profile-Update-Interval': '24',
  };
  if (traffic) {
    headers['Subscription-Userinfo'] =
      `upload=${traffic.upload}; download=${traffic.download}; total=${traffic.total}; expire=${traffic.expire}`;
  }

  return new Response(yaml, { status: 200, headers });
});
