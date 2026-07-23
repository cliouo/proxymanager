import { withProblemDetails } from '@/lib/http/handler';
import { listScenarios } from '@/lib/scenarios/registry';

export const dynamic = 'force-dynamic';

/** 仅开发环境可见的调试场景 —— 生产列表里剔除，避免出现在扩展中心。 */
const DEV_ONLY_SCENARIOS = new Set(['dev-echo']);

export const GET = withProblemDetails(async () => {
  const all = listScenarios();
  const data =
    process.env.NODE_ENV === 'development'
      ? all
      : all.filter((s) => !DEV_ONLY_SCENARIOS.has(s.id));
  return Response.json({ data });
});
