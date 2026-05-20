import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { recordEvent } from '@/lib/repos/auditRepo';
import { listRules, upsertRule } from '@/lib/repos/rulesRepo';
import {
  computeNextRank,
  ensureValidAnchorAndPolicy,
  generateRuleId,
  loadParsedBase,
  nowSeconds,
  resolveActor,
} from '@/lib/services/rulesService';
import { RuleCreateSchema, type Rule } from '@/schemas';

export const dynamic = 'force-dynamic';

const SORT_KEYS = ['rank', 'added_at', 'updated_at', 'value'] as const;
type SortKey = (typeof SORT_KEYS)[number];

const COMPARERS: Record<SortKey, (a: Rule, b: Rule) => number> = {
  rank: (a, b) => a.rank - b.rank,
  added_at: (a, b) => a.added_at - b.added_at,
  updated_at: (a, b) => a.updated_at - b.updated_at,
  value: (a, b) => a.value.localeCompare(b.value),
};

function parseInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export const GET = withProblemDetails(async (request: Request) => {
  const url = new URL(request.url);
  const params = url.searchParams;

  const anchorFilter = params.get('anchor');
  const policyFilter = params.get('policy');
  const typeFilter = params.get('type');
  const qFilter = params.get('q')?.toLowerCase() ?? null;

  const sortParam = params.get('sort') ?? 'rank';
  const [rawKey, rawDir = 'asc'] = sortParam.split(':');
  const sortKey: SortKey = (SORT_KEYS as readonly string[]).includes(rawKey)
    ? (rawKey as SortKey)
    : 'rank';
  const sortDir = rawDir === 'desc' ? -1 : 1;

  const limit = Math.min(500, Math.max(1, parseInt(params.get('limit'), 100)));
  const offset = Math.max(0, parseInt(params.get('offset'), 0));

  const all = await listRules();

  const filtered = all.filter((rule) => {
    if (anchorFilter && rule.anchor !== anchorFilter) return false;
    if (policyFilter && rule.policy !== policyFilter) return false;
    if (typeFilter && rule.type !== typeFilter) return false;
    if (qFilter) {
      const haystack = `${rule.value.toLowerCase()} ${(rule.note ?? '').toLowerCase()}`;
      if (!haystack.includes(qFilter)) return false;
    }
    return true;
  });

  const cmp = COMPARERS[sortKey];
  filtered.sort((a, b) => sortDir * cmp(a, b));

  const total = filtered.length;
  const data = filtered.slice(offset, offset + limit);

  return Response.json({ data, meta: { total, limit, offset } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = RuleCreateSchema.parse(raw);

  const parsedBase = await loadParsedBase();
  ensureValidAnchorAndPolicy(input, parsedBase);

  const rank = input.rank ?? (await computeNextRank(input.anchor));
  const now = nowSeconds();
  const rule: Rule = {
    id: generateRuleId(),
    anchor: input.anchor,
    type: input.type,
    value: input.value,
    policy: input.policy,
    rank,
    source: input.source,
    added_at: now,
    updated_at: now,
    note: input.note,
  };

  await upsertRule(rule);
  await recordEvent({
    op: 'rule.create',
    actor: resolveActor(request),
    ruleId: rule.id,
    after: rule,
  });

  return Response.json(
    { data: rule },
    {
      status: 201,
      headers: { Location: `/api/v1/rules/${rule.id}` },
    },
  );
});
