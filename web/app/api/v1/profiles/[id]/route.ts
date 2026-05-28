import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { deleteProfile, getProfile, patchProfile } from '@/lib/services/profileService';
import { ProfileUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/profiles/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const profile = await getProfile(id);
  if (!profile) throw ProblemDetailsError.notFound(`profile ${id} 不存在。`);
  return Response.json({ data: profile });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = ProfileUpdateSchema.parse(raw);
  const updated = await patchProfile(id, patch);
  return Response.json({ data: updated });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const removed = await deleteProfile(id);
  if (!removed) throw ProblemDetailsError.notFound(`profile ${id} 不存在。`);
  return new Response(null, { status: 204 });
});
