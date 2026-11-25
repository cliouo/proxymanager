import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { z } from '@/lib/openapi/zod';
import { queryMihomoDocs } from '@/lib/tools/mihomoDocs';

export const dynamic = 'force-dynamic';

const InputSchema = z.object({
  question: z.string().min(3).max(500),
  repo: z.enum(['MetaCubeX/Meta-Docs', 'MetaCubeX/mihomo']).default('MetaCubeX/Meta-Docs'),
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = InputSchema.parse(raw);
  const data = await queryMihomoDocs(input.repo, input.question);
  return Response.json({ data });
});
