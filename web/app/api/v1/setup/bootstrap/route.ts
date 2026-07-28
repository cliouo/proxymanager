import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { bootstrapSetup } from '@/lib/services/setupService';
import { SetupBootstrapRequestSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const POST = withProblemDetails(async (request: Request) => {
  const text = await request.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
    }
  }
  const input = SetupBootstrapRequestSchema.parse(raw);
  const result = await bootstrapSetup(input);
  return Response.json({ data: result }, { status: result.created ? 201 : 200 });
});
