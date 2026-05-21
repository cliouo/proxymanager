import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { expandCollections } from '@/lib/engine/collectionExpander';
import { extractStructured } from '@/lib/engine/structured';
import { getBase } from '@/lib/repos/baseRepo';

export const dynamic = 'force-dynamic';

/**
 * Structured read of base.yaml. Returns proxies + proxy-groups in enough
 * detail to power scenario UIs. Collections referenced via
 * `pm-inline-collections:` are inlined first, so what the UI sees matches
 * what Mihomo will see at /api/sub/{token}/{profile} time.
 *
 * Errors during sub fetch are tolerated (UI gets a partial view + a
 * non-fatal summary).
 */
export const GET = withProblemDetails(async () => {
  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.unprocessable(
      'Base config has not been initialized.',
    );
  }
  const { expandedContent, summary } = await expandCollections(base.content, {
    ignoreFailedSubs: true,
  });
  const structured = extractStructured(expandedContent);
  return Response.json({
    data: {
      ...structured,
      etag: base.etag,
      updated_at: base.updated_at,
      expansion: summary,
    },
  });
});
