import { withProblemDetails } from '@/lib/http/handler';
import { getResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { resolveScopeProfile } from '@/lib/profileScope';

export const dynamic = 'force-dynamic';

/**
 * 上次成功渲染的摘要快照(节点名/碰撞/订阅状态/警告/锚点统计)——只读,
 * 一次 Redis HGET,**绝不触发渲染管线或上游订阅拉取**。概览页等"只想看
 * 状态"的轻读者用它;真正需要新鲜产物的入口(/api/sub、最终配置页)
 * 才跑 resolveConfig。快照按 active profile 维度存取(P2-5),从未渲染过
 * 该 profile 时 data 为 null,前端如实提示。
 */
export const GET = withProblemDetails(async (request: Request) => {
  const profile = await resolveScopeProfile(request);
  const snapshot = await getResolvedSnapshot(profile.id);
  return Response.json({ data: snapshot });
});
