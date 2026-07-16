import { referencedProviderNamesInBaseYaml } from '@/lib/engine/renderer';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveScopeProfile } from '@/lib/profileScope';
import { getBase } from '@/lib/repos/baseRepo';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { listRuleSets } from '@/lib/services/ruleSetService';
import { resolveActor } from '@/lib/services/rulesService';
import type { RuleSet } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async (request: Request) => {
  // Meta only — content lives in its own Redis key and is returned by the
  // [id] detail route. Keeps the list payload small however big the bodies get.
  // `referenced_in_base` is relative to the active profile's base.
  const { id: profileId } = await resolveScopeProfile(request);
  const [sets, base] = await Promise.all([listRuleSets(), getBase(profileId)]);
  // Rule-sets referenced straight from the base body (e.g. mihomo DNS
  // `nameserver-policy: { rule-set:foo,bar }`) are real usages the renderer
  // honours but no RULE-SET rule names — the rules-hash usage count alone
  // would mislabel them "未被使用". Surface them so the page can mark them used.
  const baseRefs = base ? referencedProviderNamesInBaseYaml(base.content) : new Set<string>();
  const data = sets.map((s) => {
    const { content, ...meta } = s;
    void content;
    return { ...meta, referenced_in_base: baseRefs.has(s.name) };
  });
  return Response.json({ data, meta: { total: sets.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const { id: profileId } = await resolveScopeProfile(request);
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const res = await dispatch({
    scenario: 'rule-provider',
    op: 'create',
    payload: raw,
    actor: resolveActor(request),
    profileId,
  });
  const created = res.data as RuleSet;
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/rule-sets/${created.id}` } },
  );
});
