import { withProblemDetails } from '@/lib/http/handler';
import { getWorkspaceBootstrap } from '@/lib/services/setupService';
export const GET = withProblemDetails(async () =>
  Response.json(
    { data: await getWorkspaceBootstrap() },
    { headers: { 'Cache-Control': 'no-store' } },
  ),
);
