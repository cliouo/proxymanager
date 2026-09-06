import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { reorderProxyGroups } from '@/lib/services/orderService';
import { resolveActor } from '@/lib/services/rulesService';
import { ProxyGroupReorderSchema } from '@/schemas/reorder';

export const POST = withProblemDetails(async (request: Request) => {
  const { id } = await resolveScopeProfile(request);
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { orderedIds, expectedVersion } = ProxyGroupReorderSchema.parse(raw);
  return Response.json({
    data: await reorderProxyGroups(id, orderedIds, expectedVersion, resolveActor(request)),
  });
});
