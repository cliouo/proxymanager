import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { deleteDevice, getProfileDevice, patchDevice } from '@/lib/services/deviceService';
import { DeviceUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/profiles/[id]/devices/[deviceId]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  return Response.json({ data: await getProfileDevice(id, deviceId) });
});

/**
 * 改名 / 备注 / 补丁。改补丁必过 preflight —— 由 deviceService 统一保证，
 * 这里不做任何旁路判断（例如「补丁没变就跳过校验」，那会给出第二条写路径）。
 */
export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = DeviceUpdateSchema.parse(raw);
  return Response.json({ data: await patchDevice(id, deviceId, patch) });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  const removed = await deleteDevice(id, deviceId);
  if (!removed) throw ProblemDetailsError.notFound(`设备 ${deviceId} 不存在。`);
  return new Response(null, { status: 204 });
});
