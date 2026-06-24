import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { createProxyGroup, listProxyGroups } from '@/lib/services/proxyGroupService';
import { ProxyGroupCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const data = await listProxyGroups(profileId);
  return Response.json({ data, meta: { total: data.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = ProxyGroupCreateSchema.parse(raw);
  const created = await createProxyGroup(profileId, input);
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/proxy-groups/${created.id}` } },
  );
});
