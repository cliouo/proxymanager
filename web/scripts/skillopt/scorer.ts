/**
 * SkillOpt reward scorer for the proxymanager benchmark.
 *
 * Scores an artifact PRODUCED BY THE TARGET AGENT (reclaude, driven by a
 * SKILL.md under optimization) against task criteria, using proxymanager's
 * OWN engine validators so there is zero logic drift from production:
 *   - schemas/proxyGroup.ts  (ProxyGroupCreateSchema)  → schema validity
 *   - lib/proxies/filterMatch.ts (matchFilter / Go-RE2) → filter correctness
 *   - lib/engine/parser.ts   (parseBase)                → YAML/base validity
 *   - lib/engine/validator.ts (validateBase)            → orphan references
 *
 * I/O contract (so the Python rollout can shell out to it):
 *   stdin : a JSON job  { "artifact": "<agent text>", "spec": <ScorerSpec> }
 *   stdout: a JSON score { "hard": 0|1, "soft": 0..1, "detail": str,
 *                          "checks": [{name, ok, weight, msg}] }
 *
 * Run from the web/ project so node_modules + the `@/` alias resolve:
 *   echo '<job json>' | npx tsx scripts/skillopt/scorer.ts
 */
import { parse as parseYaml } from 'yaml';
import { matchFilter } from '../../lib/proxies/filterMatch';
import { parseBase } from '../../lib/engine/parser';
import { validateBase } from '../../lib/engine/validator';
import { ProxyGroupCreateSchema } from '../../schemas/proxyGroup';

type Check = { name: string; ok: boolean; weight: number; msg: string };

interface ScorerSpec {
  // proxy_group_input | regex_filter | base_yaml
  type: string;
  // shared: node-name fixture the filter is evaluated against
  node_fixture?: string[];
  must_match?: string[]; // names that MUST survive the filter
  must_not_match?: string[]; // names that MUST be dropped
  expect_type?: string; // proxy-group `type` the answer should use
  expect_field?: Record<string, unknown>; // exact field equality checks
  // base_yaml extras
  rules?: Array<{ id?: string; anchor: string; type?: string; value?: string; policy: string }>;
  managed_group_names?: string[];
  provider_names?: string[];
}

interface Job {
  artifact: string;
  spec: ScorerSpec;
}

/** Pull a fenced ```json / ```yaml block, else the first {...} object, else the raw text. */
function extractBlock(artifact: string, prefer: 'json' | 'yaml'): string {
  const fence = new RegExp('```(?:' + prefer + '|yaml|yml|json)?\\s*\\n([\\s\\S]*?)```', 'i');
  const m = fence.exec(artifact);
  if (m) return m[1].trim();
  // first balanced-looking object
  const obj = /\{[\s\S]*\}/.exec(artifact);
  if (prefer === 'json' && obj) return obj[0];
  return artifact.trim();
}

function parseObject(artifact: string): { obj: any; err: string | null } {
  const block = extractBlock(artifact, 'json');
  // try JSON first, then YAML (YAML is a superset and tolerates the mihomo style)
  try {
    return { obj: JSON.parse(block), err: null };
  } catch {
    /* fall through */
  }
  try {
    return { obj: parseYaml(block), err: null };
  } catch (e) {
    return { obj: null, err: e instanceof Error ? e.message : String(e) };
  }
}

function finalize(checks: Check[]): { hard: number; soft: number; detail: string; checks: Check[] } {
  const totalW = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const soft = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0) / totalW;
  const hard = checks.every((c) => c.ok) ? 1 : 0;
  const detail = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.msg}`).join(' | ');
  return { hard, soft: Number(soft.toFixed(4)), detail, checks };
}

function scoreFilter(
  filter: string | undefined,
  excludeFilter: string | undefined,
  spec: ScorerSpec,
  checks: Check[],
): void {
  const fixture = spec.node_fixture ?? [];
  const res = matchFilter(fixture, filter, excludeFilter);
  checks.push({
    name: 'regex-compiles',
    ok: res.error === null,
    weight: 2,
    msg: res.error === null ? 'valid Go-RE2' : `invalid: ${res.error}`,
  });
  if (res.error !== null) return;
  const matched = new Set(res.matched);
  if (spec.must_match?.length) {
    const missing = spec.must_match.filter((n) => !matched.has(n));
    checks.push({
      name: 'must-match',
      ok: missing.length === 0,
      weight: 3,
      msg: missing.length === 0 ? `all ${spec.must_match.length} kept` : `missing ${JSON.stringify(missing)}`,
    });
  }
  if (spec.must_not_match?.length) {
    const leaked = spec.must_not_match.filter((n) => matched.has(n));
    checks.push({
      name: 'must-not-match',
      ok: leaked.length === 0,
      weight: 3,
      msg: leaked.length === 0 ? 'all excluded' : `leaked ${JSON.stringify(leaked)}`,
    });
  }
}

function scoreProxyGroupInput(job: Job): ReturnType<typeof finalize> {
  const { spec } = job;
  const checks: Check[] = [];
  const { obj, err } = parseObject(job.artifact);
  checks.push({ name: 'parses', ok: obj != null && err === null, weight: 2, msg: err ?? 'ok' });
  if (obj == null) return finalize(checks);

  const parsed = ProxyGroupCreateSchema.safeParse(obj);
  checks.push({
    name: 'schema-valid',
    ok: parsed.success,
    weight: 3,
    msg: parsed.success ? 'ProxyGroupCreateSchema ok' : JSON.stringify(parsed.error.issues.slice(0, 3)),
  });

  if (spec.expect_type) {
    checks.push({
      name: 'type',
      ok: obj.type === spec.expect_type,
      weight: 1,
      msg: `got ${JSON.stringify(obj.type)} want ${spec.expect_type}`,
    });
  }
  for (const [k, v] of Object.entries(spec.expect_field ?? {})) {
    checks.push({
      name: `field:${k}`,
      ok: JSON.stringify(obj[k]) === JSON.stringify(v),
      weight: 1,
      msg: `got ${JSON.stringify(obj[k])} want ${JSON.stringify(v)}`,
    });
  }
  if (spec.node_fixture) scoreFilter(obj.filter, obj['exclude-filter'], spec, checks);
  return finalize(checks);
}

function scoreRegexFilter(job: Job): ReturnType<typeof finalize> {
  const { spec } = job;
  const checks: Check[] = [];
  // accept either a bare regex line, or an object {filter, exclude-filter}
  let filter: string | undefined;
  let exclude: string | undefined;
  const { obj } = parseObject(job.artifact);
  if (obj && typeof obj === 'object') {
    filter = obj.filter ?? obj['filter'];
    exclude = obj['exclude-filter'] ?? obj.exclude_filter;
  }
  if (!filter) {
    // bare regex: drop any <answer>-style wrapper tags, take the last real line
    const lines = job.artifact
      .replace(/<\/?answer>/gi, '\n')
      .split('\n')
      .map((l) => l.trim().replace(/^[`'"]+|[`'"]+$/g, ''))
      .filter((l) => l && !/^<\/?[a-zA-Z][\w-]*>$/.test(l)); // skip tag-only lines
    filter = lines[lines.length - 1];
  }
  checks.push({ name: 'has-filter', ok: !!filter, weight: 1, msg: filter ? `filter=${filter}` : 'no filter found' });
  if (filter) scoreFilter(filter, exclude, spec, checks);
  return finalize(checks);
}

function scoreBaseYaml(job: Job): ReturnType<typeof finalize> {
  const { spec } = job;
  const checks: Check[] = [];
  const block = extractBlock(job.artifact, 'yaml');
  let parsedBase;
  try {
    parsedBase = parseBase(block);
    checks.push({ name: 'base-parses', ok: true, weight: 2, msg: 'parseBase ok' });
  } catch (e) {
    checks.push({ name: 'base-parses', ok: false, weight: 2, msg: e instanceof Error ? e.message : String(e) });
    return finalize(checks);
  }
  const rules = (spec.rules ?? []).map((r, i) => ({
    id: r.id ?? `r${i}`,
    anchor: r.anchor,
    type: (r.type as any) ?? 'DOMAIN',
    value: r.value,
    policy: r.policy,
  })) as any;
  const result = validateBase(
    parsedBase,
    rules,
    spec.provider_names ? new Set(spec.provider_names) : undefined,
    spec.managed_group_names,
  );
  checks.push({
    name: 'no-orphans',
    ok: result.valid,
    weight: 3,
    msg: result.valid ? 'all references resolve' : `orphans: ${JSON.stringify(result.orphans.slice(0, 3))}`,
  });
  return finalize(checks);
}

function score(job: Job): ReturnType<typeof finalize> {
  switch (job.spec.type) {
    case 'proxy_group_input':
      return scoreProxyGroupInput(job);
    case 'regex_filter':
      return scoreRegexFilter(job);
    case 'base_yaml':
      return scoreBaseYaml(job);
    default:
      return finalize([{ name: 'unknown-spec', ok: false, weight: 1, msg: `unknown type ${job.spec.type}` }]);
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  let job: Job;
  try {
    job = JSON.parse(raw) as Job;
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ hard: 0, soft: 0, detail: `bad job json: ${e}`, checks: [] }) + '\n',
    );
    process.exit(0);
    return;
  }
  const out = score(job);
  process.stdout.write(JSON.stringify(out) + '\n');
}

void main();
