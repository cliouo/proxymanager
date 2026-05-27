import { z } from 'zod';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { createProxyGroups } from '@/lib/services/proxyGroupService';
import { ProxyGroupCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

/**
 * Atomic batch-create — pre-validates name uniqueness across the batch +
 * existing hash, checks templates, runs dialer-proxy cycle detection on
 * the combined final state, then writes everything in one Redis hset.
 *
 * Scenarios that emit multi-group bundles (chained-proxy's pool+wrap, the
 * all-auto-pair preset) use this so a half-success can't leave one group
 * stranded.
 */
const BatchSchema = z.object({
  groups: z.array(ProxyGroupCreateSchema).min(1).max(16),
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { groups } = BatchSchema.parse(raw);
  const created = await createProxyGroups(groups);
  return Response.json({ data: created, meta: { count: created.length } }, { status: 201 });
});
