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
      console.error('[health] unexpected redis ping response:', pong);
      return { ok: false, error: 'unavailable' };
    }
    return { ok: true };
  } catch (err) {
    // P3-15: /api/v1/health is a PUBLIC endpoint. The raw error can carry a
    // Redis hostname / connection string, so log it server-side and expose only
    // a generic marker to the caller.
    console.error('[health] redis check failed:', err);
    return { ok: false, error: 'unavailable' };
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
