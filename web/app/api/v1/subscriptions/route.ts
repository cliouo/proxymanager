import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { createSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { SubscriptionCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const subs = await listSubscriptions();
  return Response.json({ data: subs, meta: { total: subs.length } });
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
