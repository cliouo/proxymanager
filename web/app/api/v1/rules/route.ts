import { readRulePage } from '@/lib/services/rulePage';
import { operationIdentity } from '@/lib/repos/auditedMutation';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { resolveActor } from '@/lib/services/rulesService';
import { type Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

function parseInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export const GET = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const url = new URL(request.url);
  const params = url.searchParams;

  const anchorFilter = params.get('anchor');
  const policyFilter = params.get('policy');
  const typeFilter = params.get('type');
  const enabledFilter = params.get('enabled');
  if (enabledFilter !== null && !['true', 'false'].includes(enabledFilter))
    throw ProblemDetailsError.badRequest('enabled 必须为 true 或 false');
  const qFilter = params.get('q')?.toLowerCase() ?? null;

  const limit = Math.min(500, Math.max(1, parseInt(params.get('limit'), 100)));
  const offset = Math.max(0, parseInt(params.get('offset'), 0));

  return Response.json(
    await readRulePage(
      profileId,
      {
        anchor: anchorFilter,
        policy: policyFilter,
        type: typeFilter,
        enabled: enabledFilter === null ? undefined : enabledFilter === 'true',
        q: qFilter,
        sort: params.get('sort') ?? 'rank:asc',
      },
      offset,
      limit,
    ),
  );
});

/**
 * Backward-compat shim. New code can hit POST /api/v1/ops directly with
 * scenario=rule-anchor-append; this route exists so the extension and
 * existing /rules UI keep working unchanged.
 */
export const POST = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const payload = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const result = await dispatch({
    operationIdentity: operationIdentity(request, { profileId, payload }),
    scenario: 'rule-anchor-append',
    op: 'create',
    payload,
    actor: resolveActor(request),
    profileId,
  });
  const rule = result.data as Rule;
  return Response.json(
    { data: rule },
    {
      status: 201,
      headers: { Location: `/api/v1/rules/${rule.id}` },
    },
  );
});
