import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { moveRule } from '@/lib/services/orderService';
import { resolveActor } from '@/lib/services/rulesService';
import { RuleMoveSchema } from '@/schemas/reorder';

export const POST = withProblemDetails(
  async (request: Request, ctx: RouteContext<'/api/v1/rules/[id]/move'>) => {
    const { id: profileId } = await resolveScopeProfile(request);
    const { id } = await ctx.params;
    const raw = await request.json().catch(() => {
      throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
    });
    const { direction, expectedVersion } = RuleMoveSchema.parse(raw);
    return Response.json({
      data: await moveRule(profileId, id, direction, expectedVersion, resolveActor(request)),
    });
  },
);
