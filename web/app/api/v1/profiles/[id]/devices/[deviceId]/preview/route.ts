import { ConfigValidationError } from '@/lib/config/errors';
import { buildDeviceConfig, redactRenderedYaml } from '@/lib/engine/devicePatch';
import { renderProfileConfig } from '@/lib/engine/renderCache';
import { withProblemDetails } from '@/lib/http/handler';
import { getProfile } from '@/lib/repos/profilesRepo';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getProfileDevice } from '@/lib/services/deviceService';

export const dynamic = 'force-dynamic';
// 与其它渲染路由同档:冷渲染要拉上游订阅,给明确上限而不是平台默认的 10s。
export const maxDuration = 60;

type Ctx = RouteContext<'/api/v1/profiles/[id]/devices/[deviceId]/preview'>;

/**
 * 生效预览 —— 返回共享渲染与本设备渲染两份 YAML，diff 由前端算。
 *
 * 后端不算 diff 是刻意的：diff 呈现方式（并排 / 内联 / 折叠上下文）是纯展示决策，
 * 而两份全文既能算 diff 也能直接看，没必要在服务端固化一种呈现。
 *
 * 补丁非法时**不 500**：`issues` 里带结构化说明、`device` 为 null，页面照样能显示
 * 共享侧并把错误标到具体键上——这正是用户修补丁时最需要的画面。
 *
 * 两侧 YAML 都过敏感键掩码：预览是展示面，不该成为第二个吐真 secret 的接口。
 * 掩码在**校验之后**做 —— 校验必须看真实产物，掩码只作用于回给前端的那份文本。
 */
export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id, deviceId } = await ctx.params;
  const profile = await getProfile(id);
  if (!profile) throw ProblemDetailsError.notFound(`profile ${id} 不存在。`);
  const device = await getProfileDevice(id, deviceId);

  const shared = await renderProfileConfig(profile.name);

  let deviceYaml: string | null = null;
  const issues: ConfigValidationError['issue'][] = [];
  try {
    deviceYaml = buildDeviceConfig(
      shared.resolved.content,
      device.base_patch,
      device.name,
      device.features,
    );
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) throw error;
    issues.push(error.issue);
  }

  return Response.json({
    data: {
      shared: redactRenderedYaml(shared.resolved.content),
      device: deviceYaml === null ? null : redactRenderedYaml(deviceYaml),
      issues,
    },
  });
});
