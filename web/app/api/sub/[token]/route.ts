export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/sub/[token]'>;

export async function GET(_request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  return new Response(null, {
    status: 302,
    headers: { Location: `/api/sub/${token}/default` },
  });
}
