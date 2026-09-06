import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { resolveScopeProfile, resolveScopeProfileName } from '@/lib/profileScope';
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
  const profile = (new URL(request.url).searchParams.has('profileId') || new URL(request.url).searchParams.has('profile'))
    ? await resolveScopeProfile(request)
    : await getProfileByName(resolveScopeProfileName(request));
  const profileName = profile?.name ?? resolveScopeProfileName(request);
  const base = profile ? await getBase(profile.id) : null;

  return Response.json({
    data: {
      capabilities: { profileIdScope: true },
      // Follow the active (switcher-selected) profile, not a hardcoded default,
      // so 总览的订阅地址随切换器一起切换。
      subscriptionUrl: `${origin}/api/sub/${token}/${encodeURIComponent(profileName)}`,
      // 分发链接前缀:`{subBase}/source/{订阅名}`、`{subBase}/collection/{聚合名}`。
      subBase: `${origin}/api/sub/${token}`,
      ruleProvidersBase: `${origin}/api/rule-providers/${token}`,
      buildId: base?.etag ?? null,
      hasBase: base !== null,
    },
  });
});
