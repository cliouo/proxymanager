import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.notFound('Base config has not been initialized yet.');
  }
  return Response.json({ data: base.anchors });
});
