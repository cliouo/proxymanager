import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { safeFetchText } from '@/lib/net/safeFetch';
import { z } from '@/lib/openapi/zod';

export const dynamic = 'force-dynamic';

const FETCH_URL_MAX_BYTES = 64_000;

const InputSchema = z.object({
  url: z.string().min(1).max(2000),
  reader: z.boolean().optional(),
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = InputSchema.parse(raw);
  const fetched = await safeFetchText(input.url, {
    reader: input.reader,
    maxBytes: FETCH_URL_MAX_BYTES,
  });
  return Response.json({
    data: {
      url: input.url,
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      truncated: fetched.truncated,
      content: fetched.text,
      untrusted: true as const,
    },
  });
});
