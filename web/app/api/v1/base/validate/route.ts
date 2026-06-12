import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { parseAndValidate } from '@/lib/services/baseService';
import { BaseUpdateRequestSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const POST = withProblemDetails(async (request: Request) => {
  const rawBody = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { content } = BaseUpdateRequestSchema.parse(rawBody);
  const { parsedBase, validation } = await parseAndValidate(content);
  return Response.json({
    data: {
      valid: validation.valid,
      anchors: parsedBase.anchors,
      // 合并后的策略全集(托管策略组 + base 字面)，Inspector 直接展示。
      policies: validation.policies,
      orphans: validation.orphans,
    },
  });
});
