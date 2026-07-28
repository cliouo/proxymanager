import { withProblemDetails } from '@/lib/http/handler';
import { getSetupStatus } from '@/lib/services/setupService';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  return Response.json(
    { data: await getSetupStatus() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
