import { getRedis } from '@/lib/redis/client';

export const dynamic = 'force-dynamic';

interface CheckResult {
  ok: boolean;
  error?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: {
    redis: CheckResult;
  };
  uptime_seconds: number;
  timestamp: string;
  build_id: string | null;
}

async function checkRedis(): Promise<CheckResult> {
  try {
    const pong = await getRedis().ping();
    if (pong !== 'PONG') {
      return { ok: false, error: `unexpected ping response: ${String(pong)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const redis = await checkRedis();
  const allOk = redis.ok;
  const body: HealthResponse = {
    status: allOk ? 'ok' : 'degraded',
    checks: { redis },
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    build_id: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? null,
  };
  return Response.json(body, { status: allOk ? 200 : 503 });
}
