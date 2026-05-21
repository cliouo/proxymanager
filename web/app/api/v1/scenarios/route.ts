import { withProblemDetails } from '@/lib/http/handler';
import { listScenarios } from '@/lib/scenarios/registry';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  return Response.json({ data: listScenarios() });
});
