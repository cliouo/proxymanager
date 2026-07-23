import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { createDevice, listProfileDevices } from '@/lib/services/deviceService';
import { DeviceCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/profiles/[id]/devices'>;

/**
 * 设备是 profile 的子资源，鉴权与 /api/v1/profiles 完全一致（admin 中间件）。
 * 列表返回完整 base_patch —— 管理界面要按键渲染差异卡片。补丁里的敏感值只在
 * **审计快照**里掩码，这里不掩：掩了用户就没法在设备详情页看到并修改自己写的值。
 */
export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const data = await listProfileDevices(id);
  return Response.json({ data, meta: { total: data.length } });
});

export const POST = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = DeviceCreateSchema.parse(raw);
  const created = await createDevice(id, input);
  return Response.json(
    { data: created },
    {
      status: 201,
      headers: { Location: `/api/v1/profiles/${id}/devices/${created.id}` },
    },
  );
});
