import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteDeviceTailscaleFeature,
  getDeviceTailscaleFeature,
  putDeviceTailscaleFeature,
} from '@/lib/services/deviceService';
import { TailscaleDeviceFeatureUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/profiles/[id]/devices/[deviceId]/features/tailscale'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  return Response.json({ data: await getDeviceTailscaleFeature(id, deviceId) });
});

export const PUT = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  return Response.json({
    data: await putDeviceTailscaleFeature(
      id,
      deviceId,
      TailscaleDeviceFeatureUpdateSchema.parse(raw),
    ),
  });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  const result = await deleteDeviceTailscaleFeature(id, deviceId);
  if (!result) throw ProblemDetailsError.notFound('这台设备没有启用 Tailscale。');
  return Response.json({ data: result });
});
