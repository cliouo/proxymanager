import { withProblemDetails } from '@/lib/http/handler';
import { projectAliasKeysToHandles } from '@/lib/services/sourceAliasResolver';
import { ProblemDetailsError } from '@/lib/http/problem';
import { createSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { SubscriptionCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const subs = await listSubscriptions();
  // pass-6 blocker 2: same opaque alias projection on the list surface
  const data = subs.map((sub) => ({
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
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/subscriptions/${created.id}` } },
  );
});
