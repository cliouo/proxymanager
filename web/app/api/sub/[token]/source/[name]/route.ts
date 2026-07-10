import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { guardSubToken } from '@/lib/http/subGuard';
import { nodeExportResponse } from '@/lib/http/providerResponse';
import { exportSubscriptionNodes } from '@/lib/services/nodeExportService';
import { getSubscriptionByName } from '@/lib/services/subscriptionService';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = RouteContext<'/api/sub/[token]/source/[name]'>;

/**
 * 单订阅源的公开分发链接 —— 只下发该源处理后的节点(operators 节点处理 +
 * 去重),输出 `proxies:` provider YAML。任何 mihomo / Clash
 * 客户端可把它当 proxy-provider `url:` 或普通订阅使用;上游源站地址永不暴露。
 * 停用的源对外 404(与「未分发」语义一致)。`?noCache=1` 强制绕过 fetch 缓存。
 */
export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, name } = await ctx.params;
  await guardSubToken(request, token, name);

  const sub = await getSubscriptionByName(name);
  if (!sub) {
    throw ProblemDetailsError.notFound(`Subscription "${name}" not found.`);
  }
  if (!sub.enabled) {
    throw ProblemDetailsError.notFound(`Subscription "${name}" 已停用,公开链接暂不可用。`);
  }

  const noCache = new URL(request.url).searchParams.get('noCache') === '1';
  const result = await exportSubscriptionNodes(sub, { noCache });
  return nodeExportResponse(request, result, `pm-source-${sub.name}.yaml`);
});
