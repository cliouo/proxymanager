import { withProblemDetails } from '@/lib/http/handler';
import { resolveScopeProfile } from '@/lib/profileScope';
import { getDashboardSummary } from '@/lib/repos/dashboardRepo';
import { deriveSubToken } from '@/lib/auth';
import { getSubscriptionFetchHealthMany } from '@/lib/repos/subscriptionFetchHealthRepo';
import { projectSubscriptionAdminView } from '@/lib/services/subscriptionService';
import { SubscriptionSchema, type Subscription } from '@/schemas';

export const GET = withProblemDetails(async (request: Request) => {
  const profile = await resolveScopeProfile(request);
  const summary = await getDashboardSummary(profile.id);
  const subscriptions: Subscription[] = (
    Array.isArray(summary.subscriptions) ? summary.subscriptions : []
  ).flatMap((raw: unknown) => {
    const parsed = SubscriptionSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const remoteIds = subscriptions.filter((sub) => sub.kind !== 'local').map((sub) => sub.id);
  const health = remoteIds.length ? await getSubscriptionFetchHealthMany(remoteIds) : [];
  const byId = new Map(remoteIds.map((id, i) => [id, health[i]]));
  summary.subscriptionHealthSummary = subscriptions.map((sub) => {
    const view = projectSubscriptionAdminView(sub, byId.get(sub.id));
    return { name: sub.name, display_name: sub.display_name, fetch_health: view.fetch_health };
  });
  delete summary.subscriptions;
  if (summary.lastRenderSummary) {
    for (const key of ['subscriptions', 'warnings', 'unmatchedAnchors']) {
      if (!Array.isArray(summary.lastRenderSummary[key])) summary.lastRenderSummary[key] = [];
    }
  }
  if (!Array.isArray(summary.recentEventSummaries)) summary.recentEventSummaries = [];
  summary.meta = {
    hasBase: summary.hasBase,
    buildId: summary.buildId ?? null,
    subscriptionUrl: `${new URL(request.url).origin}/api/sub/${deriveSubToken({ type: 'profile', id: profile.id, tokenVersion: profile.token_version })}/${encodeURIComponent(profile.name)}`,
  };
  return Response.json({ data: summary }, { headers: { 'Cache-Control': 'no-store' } });
});
