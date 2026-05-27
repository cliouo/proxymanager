import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  createProxyGroupTemplate,
  listProxyGroupTemplates,
} from '@/lib/services/proxyGroupTemplateService';
import { ProxyGroupTemplateCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const data = await listProxyGroupTemplates();
  return Response.json({ data, meta: { total: data.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = ProxyGroupTemplateCreateSchema.parse(raw);
  const created = await createProxyGroupTemplate(input);
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/proxy-group-templates/${created.id}` } },
  );
});
