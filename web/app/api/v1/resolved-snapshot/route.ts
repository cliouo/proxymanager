import { withProblemDetails } from '@/lib/http/handler';
import { getResolvedSnapshot } from '@/lib/repos/resolvedRepo';

export const dynamic = 'force-dynamic';

/**
 * 上次成功渲染的摘要快照(节点名/碰撞/订阅状态/警告/锚点统计)——只读,
 * 一次 Redis GET,**绝不触发渲染管线或上游订阅拉取**。概览页等"只想看
 * 状态"的轻读者用它;真正需要新鲜产物的入口(/api/sub、最终配置页)
 * 才跑 resolveConfig。从未渲染过时 data 为 null,前端如实提示。
 */
export const GET = withProblemDetails(async () => {
  const snapshot = await getResolvedSnapshot();
  return Response.json({ data: snapshot });
});
