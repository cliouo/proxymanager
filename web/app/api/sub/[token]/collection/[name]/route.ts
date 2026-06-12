import { requireSubToken } from '@/lib/auth';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { nodeExportResponse } from '@/lib/http/providerResponse';
import { exportCollectionNodes } from '@/lib/services/nodeExportService';
import { getCollection, getCollectionByName } from '@/lib/services/collectionService';
import { listSubscriptions } from '@/lib/services/subscriptionService';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/sub/[token]/collection/[name]'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 聚合订阅的公开分发链接 —— 成员订阅(直接指定 + 标签匹配,启用的)合并、
 * 去重后输出 `proxies:` provider YAML。一条链接对外,换/加成员不影响它。
 * `name` 段优先按聚合名称匹配(URL 编码的中文名也行),长得像 UUID 时回退
 * 按 id 查 —— 名称可改,id 永远稳定。停用的聚合对外 404。
 */
export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, name } = await ctx.params;
  requireSubToken(token);

  const collection =
    (await getCollectionByName(name)) ?? (UUID_RE.test(name) ? await getCollection(name) : null);
  if (!collection) {
    throw ProblemDetailsError.notFound(`Collection "${name}" not found.`);
  }
  if (!collection.enabled) {
    throw ProblemDetailsError.notFound(`聚合订阅「${collection.name}」已停用,公开链接暂不可用。`);
  }

  const noCache = new URL(request.url).searchParams.get('noCache') === '1';
  const subs = await listSubscriptions();
  const result = await exportCollectionNodes(collection, subs, { noCache });
  return nodeExportResponse(request, result, `pm-collection-${collection.name}.yaml`);
});
