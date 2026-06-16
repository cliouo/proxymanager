import { withProblemDetails } from '@/lib/http/handler';
import { summariseChains } from '@/lib/scenarios/chained-proxy/scenario';

export const dynamic = 'force-dynamic';

/**
 * Authoritative chain list, read straight from the proxy-groups hash (the
 * source of truth for chain *definitions*). The resolved config can't be used
 * for this: chained-proxy wraps are realized there as cloned `proxies:`
 * entries (a proxy-group can't carry `dialer-proxy`), which drops the backend
 * name the UI needs. The form pickers still read /api/v1/base/parsed for the
 * live proxy + group names.
 */
export const GET = withProblemDetails(async () => {
  const { fixedChains, poolChains } = await summariseChains();
  return Response.json({ data: { fixedChains, poolChains } });
});
