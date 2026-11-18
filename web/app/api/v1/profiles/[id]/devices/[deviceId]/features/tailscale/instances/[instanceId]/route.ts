import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteDeviceTailscaleInstance,
  putDeviceTailscaleInstance,
} from '@/lib/services/deviceService';
import { TailscaleInstanceUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

/**
 * One additional Tailscale instance, addressed by its immutable id.
 *
 * The id is server-generated and never derived from the hostname, so an edited
 * hostname keeps the same instance, state directory and audit trail.
 */
type Ctx =
  RouteContext<'/api/v1/profiles/[id]/devices/[deviceId]/features/tailscale/instances/[instanceId]'>;

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id, deviceId, instanceId } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = TailscaleInstanceUpdateSchema.parse(raw);
  const result = await putDeviceTailscaleInstance(id, deviceId, instanceId, input);
  return Response.json({ data: result.instance, warnings: result.warnings });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id, deviceId, instanceId } = await ctx.params;
  const result = await deleteDeviceTailscaleInstance(id, deviceId, instanceId);
  if (!result.deleted) throw ProblemDetailsError.notFound(`实例 ${instanceId} 不存在。`);
  return Response.json({ data: null, warnings: result.warnings });
});
