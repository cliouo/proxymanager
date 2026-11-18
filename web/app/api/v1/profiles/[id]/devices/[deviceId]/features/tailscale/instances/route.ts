import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  createDeviceTailscaleInstance,
  listDeviceTailscaleInstances,
} from '@/lib/services/deviceService';
import { TailscaleInstanceCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

/**
 * Additional Tailscale instances of one device.
 *
 * These routes never touch the legacy slot: `.../features/tailscale` stays the
 * original single-instance API, so existing clients keep their exact target
 * while the Web UI and newer MCP tools manage extra instances here.
 */
type Ctx = RouteContext<'/api/v1/profiles/[id]/devices/[deviceId]/features/tailscale/instances'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  const result = await listDeviceTailscaleInstances(id, deviceId);
  return Response.json({ data: result.instances, warnings: result.warnings });
});

export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = TailscaleInstanceCreateSchema.parse(raw);
  const result = await createDeviceTailscaleInstance(id, deviceId, input);
  return Response.json(
    { data: result.instance, warnings: result.warnings },
    {
      status: 201,
      headers: {
        Location: `/api/v1/profiles/${id}/devices/${deviceId}/features/tailscale/instances/${result.instance.id}`,
      },
    },
  );
});
