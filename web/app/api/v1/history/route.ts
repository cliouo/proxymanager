import { withProblemDetails } from '@/lib/http/handler';
import { listEvents } from '@/lib/repos/auditRepo';

export const dynamic = 'force-dynamic';

// P2-19: 操作历史/审计日志按【账户】全量记录 —— listEvents 不接受、也不做任何配置文件过滤。
// 因此历史页(app/(authed)/history/page.tsx)上的 <ScopePill /> 会误导为「当前配置文件」作用域;
// 正确做法是该页改用 <ScopePill neutral />(中性「全账户」徽标,见 components/Topbar.tsx)。
// 该页为 page.tsx,不在本次改动范围内,仅在此记录后端无过滤的事实与前端修法。

function parseIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export const GET = withProblemDetails(async (request: Request) => {
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, parseIntParam(url.searchParams.get('limit'), 100)));
  const beforeTsRaw = url.searchParams.get('before_ts');
  const beforeTs = beforeTsRaw !== null ? Number(beforeTsRaw) : undefined;
  const data = await listEvents({
    limit,
    beforeTs: Number.isFinite(beforeTs) ? beforeTs : undefined,
  });
  return Response.json({ data, meta: { limit, count: data.length } });
});
