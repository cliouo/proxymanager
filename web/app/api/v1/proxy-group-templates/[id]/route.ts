import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteProxyGroupTemplate,
  getProxyGroupTemplate,
  patchProxyGroupTemplate,
} from '@/lib/services/proxyGroupTemplateService';
import { ProxyGroupTemplateUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/proxy-group-templates/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const tpl = await getProxyGroupTemplate(id);
  if (!tpl) throw ProblemDetailsError.notFound(`proxy-group-template ${id} not found.`);
  return Response.json({ data: tpl });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = ProxyGroupTemplateUpdateSchema.parse(raw);
  const updated = await patchProxyGroupTemplate(id, patch);
  return Response.json({ data: updated });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const removed = await deleteProxyGroupTemplate(id);
  if (!removed) throw ProblemDetailsError.notFound(`proxy-group-template ${id} not found.`);
  return new Response(null, { status: 204 });
});
