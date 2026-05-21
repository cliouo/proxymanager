import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { extractStructured } from '@/lib/engine/structured';
import { getBase } from '@/lib/repos/baseRepo';

export const dynamic = 'force-dynamic';

/**
 * Structured read of base.yaml. Returns proxies + proxy-groups in enough
 * detail to power scenario UIs without each having to parse YAML on the
 * client. Etag from the meta record is included so scenarios can detect
 * stale views.
 */
export const GET = withProblemDetails(async () => {
  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.unprocessable(
      'Base config has not been initialized.',
    );
  }
  const structured = extractStructured(base.content);
  return Response.json({
    data: { ...structured, etag: base.etag, updated_at: base.updated_at },
  });
});
