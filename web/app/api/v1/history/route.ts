import { withProblemDetails } from '@/lib/http/handler';
import { listEvents } from '@/lib/repos/auditRepo';

export const dynamic = 'force-dynamic';

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
