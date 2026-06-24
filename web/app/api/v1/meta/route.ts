import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { resolveScopeProfileName } from '@/lib/profileScope';
import { getProfileByName } from '@/lib/repos/profilesRepo';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async (request: Request) => {
  const token = process.env.SUB_TOKEN;
  if (!token) {
    throw ProblemDetailsError.internal('SUB_TOKEN env var is not configured.');
  }

  const origin = new URL(request.url).origin;
  // Resolve the active profile's base for the buildId/hasBase hints; tolerate a
  // missing record (pre-init) by leaving base null rather than 404-ing meta.
  const profile = await getProfileByName(resolveScopeProfileName(request));
  const base = profile ? await getBase(profile.id) : null;

  return Response.json({
    data: {
      subscriptionUrl: `${origin}/api/sub/${token}/default`,
      // 分发链接前缀:`{subBase}/source/{订阅名}`、`{subBase}/collection/{聚合名}`。
      subBase: `${origin}/api/sub/${token}`,
      ruleProvidersBase: `${origin}/api/rule-providers/${token}`,
      buildId: base?.etag ?? null,
      hasBase: base !== null,
    },
  });
});
