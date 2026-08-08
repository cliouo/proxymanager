import { withProblemDetails } from '@/lib/http/handler';
import { projectAliasKeysToHandles } from '@/lib/services/sourceAliasResolver';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  createSubscription,
  listSubscriptionAdminViews,
  projectSubscriptionAdminView,
} from '@/lib/services/subscriptionService';
import { getSubscriptionFetchHealth } from '@/lib/repos/subscriptionFetchHealthRepo';
import { SubscriptionCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  // P-FFP v1: the admin view projection (effective policy + fingerprint-joined
  // health for remote rows; neither for local) is centralized here.
  const views = await listSubscriptionAdminViews();
  // pass-6 blocker 2: same opaque alias projection on the list surface
  const data = views.map((sub) => ({
    ...sub,
    operators: (sub.operators ?? []).map((op) => {
      if ((op as { kind?: string }).kind !== 'rename-template') return op;
      const aliases = (op as { sourceAliases?: Record<string, string> }).sourceAliases;
      if (aliases === undefined) return op;
      return { ...op, sourceAliases: projectAliasKeysToHandles(aliases, [sub.name]) };
    }),
  }));
  return Response.json({ data, meta: { total: data.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = SubscriptionCreateSchema.parse(raw);
  const created = await createSubscription(input);
  // P-FFP v1: the admin view is projected from the COMMITTED candidate (no
  // re-read race); health is fingerprint-joined and null when absent. LOCAL
  // sources never consult health storage (invariant 1).
  const view =
    created.kind === 'local'
      ? projectSubscriptionAdminView(created)
      : projectSubscriptionAdminView(created, await getSubscriptionFetchHealth(created.id));
  return Response.json(
    { data: view },
    { status: 201, headers: { Location: `/api/v1/subscriptions/${created.id}` } },
  );
});
