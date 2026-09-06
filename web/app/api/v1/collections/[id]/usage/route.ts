import { withProblemDetails } from '@/lib/http/handler';
import { sourceUsage } from '@/lib/services/sourceUsage';
export const GET = withProblemDetails(
  async (_request: Request, ctx: RouteContext<'/api/v1/collections/[id]/usage'>) => {
    const { id } = await ctx.params;
    return Response.json(await sourceUsage('collection', id));
  },
);
