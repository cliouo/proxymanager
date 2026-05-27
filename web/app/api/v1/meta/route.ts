import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async (request: Request) => {
  const token = process.env.SUB_TOKEN;
  if (!token) {
    throw ProblemDetailsError.internal('SUB_TOKEN env var is not configured.');
  }

  const origin = new URL(request.url).origin;
  const base = await getBase();

  return Response.json({
    data: {
      subscriptionUrl: `${origin}/api/sub/${token}/default`,
      ruleProvidersBase: `${origin}/api/rule-providers/${token}`,
      buildId: base?.etag ?? null,
      hasBase: base !== null,
    },
  });
});
