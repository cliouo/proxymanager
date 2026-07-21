import { withProblemDetails } from '@/lib/http/handler';
import { resolveScopeProfile } from '@/lib/profileScope';
import { summariseTailscale } from '@/lib/scenarios/tailscale/scenario';

export const dynamic = 'force-dynamic';

/**
 * Read side of the tailscale scenario: shape-detected artifacts (tailscale
 * base-literal nodes, groups referencing them, rules targeting those groups)
 * plus the base's rule anchors for the wizard form. auth-key values never
 * leave the server — nodes carry a `hasAuthKey` flag instead.
 */
export const GET = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const summary = await summariseTailscale(profileId);
  return Response.json({ data: summary });
});
