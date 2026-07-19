import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { guardSubToken } from '@/lib/http/subGuard';
import { nodeExportResponse, parseNodeExportFormat } from '@/lib/http/providerResponse';
import { exportCollectionNodes } from '@/lib/services/nodeExportService';
import {
  getCollection,
  getCollectionByName,
  getCollectionBySlug,
} from '@/lib/services/collectionService';
import { listSubscriptions } from '@/lib/services/subscriptionService';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = RouteContext<'/api/sub/[token]/collection/[name]'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 聚合订阅的公开分发链接 —— 成员订阅(直接指定 + 标签匹配,启用的)合并、
 * (跑聚合自己的「节点处理」)、去重后下发。默认输出 `proxies:` provider
 * YAML;`?format=base64` 输出通用分享链接订阅(v2ray 格式,Shadowrocket /
 * v2rayN 等可导入)。一条链接对外,换/加成员不影响它。`name` 段优先按聚合
 * slug(英文标识)匹配,长得像 UUID 时回退按 id 查 —— slug 不可变、id 永远
 * 稳定。为兼容历史链接,slug/id 都不命中时再按显示名兜底。停用的聚合对外 404。
 */
export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, name } = await ctx.params;
  await guardSubToken(request, token, name);
  const format = parseNodeExportFormat(request);

  const collection =
    (await getCollectionBySlug(name)) ??
    (UUID_RE.test(name) ? await getCollection(name) : null) ??
    (await getCollectionByName(name));
  if (!collection) {
    throw ProblemDetailsError.notFound(`Collection "${name}" not found.`);
  }
  if (!collection.enabled) {
    throw ProblemDetailsError.notFound(`聚合订阅「${collection.name}」已停用,公开链接暂不可用。`);
  }

  const noCache = new URL(request.url).searchParams.get('noCache') === '1';
  const subs = await listSubscriptions();
  const result = await exportCollectionNodes(collection, subs, { noCache });
  return nodeExportResponse(
    request,
    result,
    `pm-collection-${collection.slug ?? collection.id}`,
    format,
  );
});
