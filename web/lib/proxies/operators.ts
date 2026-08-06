/**
 * Node-processing engine — runs a subscription's `operators` pipeline over
 * the parsed Clash proxy list. Pure + deterministic: same proxies + same
 * operators ⇒ same output, so it's safe to run on every resolve and in the
 * preview endpoint.
 *
 * Each operator returns the transformed list plus a small trace
 * (`OperatorStep`) the workbench renders next to the pipeline so the user
 * sees exactly what each step did (− dropped, ✎ changed).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Operator } from '@/schemas/operator';
import { applyRenameTemplate, type OrdinalResolver } from './naming';
import { redactSensitiveText } from './namingSanitize';
import { sourceOf } from './provenance';
import { detectRegion, flagFromCode, regionByCode, stripFlags } from './regions';
import { assertSafeRuntimeRegexInput, compileSafeRuntimeRegex } from './regexSafety';

/** Loose Clash proxy shape — we only touch a handful of fields. */
export interface ClashProxy {
  name?: string;
  type?: string;
  server?: string;
  port?: number | string;
  udp?: boolean;
  tfo?: boolean;
  'skip-cert-verify'?: boolean;
  [key: string]: unknown;
}

export interface OperatorStep {
  id: string;
  kind: Operator['kind'];
  /** Whether the step ran (false when `disabled`). */
  applied: boolean;
  before: number;
  after: number;
  /** Nodes removed (filters / dedup-drop). */
  dropped: number;
  /** Nodes whose name or props changed (rename / flag / set-prop / dedup-rename). */
  changed: number;
  /**
   * rename-template only: formatted names that collided and were
   * disambiguated with a deterministic meaningful suffix (pre-treatment
   * duplicates).
   */
  collisions?: string[];
  /**
   * rename-template only: TRUE duplicates removed by node identity (canonical
   * config fingerprint) — same node with different display names dedups once
   * per the source-priority policy. Diagnostic provenance for the preview.
   */
  deduped?: Array<{ kept: string; dropped: string; sourceKey?: string }>;
  /**
   * Bounded representative name samples: up to {@link STEP_SAMPLE_CAP} names
   * from the step's input head and its output head (deterministic, privacy-
   * safe — display names only). The workbench shows these per step so users
   * see what each operator actually produced, not just counts.
   */
  samples?: { before: string; after: string }[];
}

/** Cap on per-step name samples. */
export const STEP_SAMPLE_CAP = 3;

/**
 * Node names can embed credential-like text, and step traces flow into AI
 * action results — samples are therefore REDACTED (same sanitizer as the AI
 * payload) and bounded at creation, never raw display names.
 */
function safeSampleName(name: string): string {
  const redacted = redactSensitiveText(name).replace(/\s+/g, ' ').trim();
  return (redacted === '' ? '(已脱敏)' : redacted).slice(0, 64);
}

/** Bounded, redacted source-key projection for trace diagnostics. */
function safeLabel(text: string): string {
  const redacted = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  return (redacted === '' ? '(未命名)' : redacted).slice(0, 48);
}

/** Bounded representative before/after pairs from a step's input/output heads. */
function stepSamples(
  before: ClashProxy[],
  after: ClashProxy[],
): { before: string; after: string }[] {
  const n = Math.min(STEP_SAMPLE_CAP, before.length, after.length);
  const out: { before: string; after: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const b = typeof before[i].name === 'string' ? (before[i].name as string) : '';
    const a = typeof after[i].name === 'string' ? (after[i].name as string) : '';
    if (b === '' && a === '') continue;
    out.push({ before: safeSampleName(b), after: safeSampleName(a) });
  }
  return out;
}

export interface ApplyResult {
  proxies: ClashProxy[];
  steps: OperatorStep[];
}

/* ─── name helpers ─────────────────────────────────────────────────── */

function nameOf(p: ClashProxy): string {
  return typeof p.name === 'string' ? p.name : '';
}

/** Built-in junk patterns for the 去除无用节点 operator. */
const USELESS_PATTERNS = [
  '剩余流量',
  '剩余',
  '到期',
  '过期',
  '重置',
  '距离',
  '官网',
  '网址',
  '续费',
  '订阅',
  '邀请',
  '失联',
  '客服',
  '群组',
  '频道',
  '公告',
  '更新于',
  '套餐',
  '维护',
  '购买',
  '充值',
  '此处',
  '请勿',
  '禁止',
  'expire',
  'traffic',
  'reset',
  'remaining',
  't\\.me',
  'telegram',
  'https?://',
];

function buildUselessRegexes(extra: string[]): RegExp[] {
  // The schema (uselessExtraPattern) already rejects fragments that don't
  // compile or match the empty string, but legacy operators stored before that
  // guard existed can still carry a bad fragment. Wrap each user fragment in a
  // non-capturing group (so its internal `|` can't spill into a sibling branch)
  // Fail closed for legacy values as well: silently skipping an unsafe fragment
  // makes the stored pipeline behave differently from what the user configured.
  const patterns = [...USELESS_PATTERNS];
  for (const e of extra) {
    if (e.trim().length === 0) {
      throw new Error('Unsafe or invalid filter-useless regular expression.');
    }
    const re = compileSafeRuntimeRegex(e, 'i');
    if (re.test('')) throw new Error('A filter-useless expression matches the empty string.');
    patterns.push(e);
  }
  // Compile separately instead of joining with `|`: overlapping fixed words
  // such as "剩余"/"剩余流量" are linear individually, while a combined
  // alternation is needlessly ambiguous to a backtracking engine.
  return patterns.map((pattern) => compileSafeRuntimeRegex(pattern, 'i'));
}

/** Compile a user regex; `test`-safe (no sticky/global state leakage). */
function compileTest(pattern: string, flags?: string): RegExp {
  const f = (flags ?? 'i').replace(/[gy]/g, ''); // test() must be stateless
  return compileSafeRuntimeRegex(pattern, f);
}

/* ─── per-operator transforms ──────────────────────────────────────── */

function runOne(
  proxies: ClashProxy[],
  op: Operator,
  ordinalResolver?: OrdinalResolver,
): {
  proxies: ClashProxy[];
  dropped: number;
  changed: number;
  collisions?: string[];
  deduped?: Array<{ kept: string; dropped: string; sourceKey?: string }>;
} {
  const before = proxies.length;

  switch (op.kind) {
    case 'filter-regex': {
      const re = compileTest(op.pattern, op.flags);
      const kept = proxies.filter((p) => {
        const name = nameOf(p);
        assertSafeRuntimeRegexInput(name);
        const hit = re.test(name);
        return op.mode === 'keep' ? hit : !hit;
      });
      return { proxies: kept, dropped: before - kept.length, changed: 0 };
    }

    case 'filter-useless': {
      const regexes = buildUselessRegexes(op.extra ?? []);
      const kept = proxies.filter((p) => {
        const name = nameOf(p);
        assertSafeRuntimeRegexInput(name);
        return !regexes.some((re) => re.test(name));
      });
      return { proxies: kept, dropped: before - kept.length, changed: 0 };
    }

    case 'filter-type': {
      if (!op.types || op.types.length === 0) return { proxies, dropped: 0, changed: 0 };
      const set = new Set<string>(op.types);
      const kept = proxies.filter((p) => {
        const hit = typeof p.type === 'string' && set.has(p.type);
        return op.mode === 'keep' ? hit : !hit;
      });
      return { proxies: kept, dropped: before - kept.length, changed: 0 };
    }

    case 'filter-region': {
      if (!op.regions || op.regions.length === 0) return { proxies, dropped: 0, changed: 0 };
      const set = new Set(op.regions.map((r) => r.toUpperCase()));
      const kept = proxies.filter((p) => {
        const code = detectRegion(nameOf(p));
        const hit = code != null && set.has(code);
        return op.mode === 'keep' ? hit : !hit;
      });
      return { proxies: kept, dropped: before - kept.length, changed: 0 };
    }

    case 'rename-regex': {
      const re = compileSafeRuntimeRegex(op.pattern, op.flags ?? 'g');
      let changed = 0;
      const out = proxies.map((p) => {
        const name = nameOf(p);
        if (!name) return p;
        assertSafeRuntimeRegexInput(name);
        const next = name.replace(re, op.replacement ?? '');
        if (next === name) return p;
        changed += 1;
        return { ...p, name: next };
      });
      return { proxies: out, dropped: 0, changed };
    }

    case 'flag-emoji': {
      let changed = 0;
      const out = proxies.map((p) => {
        const name = nameOf(p);
        if (!name) return p;
        if (op.action === 'remove') {
          const next = stripFlags(name);
          if (next === name) return p;
          changed += 1;
          return { ...p, name: next };
        }
        const code = detectRegion(name);
        if (!code) return p;
        const flagCode = op.tw2cn && code === 'TW' ? 'CN' : code;
        const emoji = regionByCode(flagCode)?.emoji ?? flagFromCode(flagCode);
        if (!emoji) return p;
        const next = `${emoji} ${stripFlags(name)}`.trim();
        if (next === name) return p;
        changed += 1;
        return { ...p, name: next };
      });
      return { proxies: out, dropped: 0, changed };
    }

    case 'set-prop': {
      let changed = 0;
      const out = proxies.map((p) => {
        const patch: Partial<ClashProxy> = {};
        if (op.udp !== undefined && p.udp !== op.udp) patch.udp = op.udp;
        if (op.tfo !== undefined && p.tfo !== op.tfo) patch.tfo = op.tfo;
        if (op.skipCertVerify !== undefined && p['skip-cert-verify'] !== op.skipCertVerify) {
          patch['skip-cert-verify'] = op.skipCertVerify;
        }
        if (Object.keys(patch).length === 0) return p;
        changed += 1;
        return { ...p, ...patch };
      });
      return { proxies: out, dropped: 0, changed };
    }

    case 'dedup': {
      const seen = new Set<string>();
      const counts = new Map<string, number>();
      const out: ClashProxy[] = [];
      let dropped = 0;
      let changed = 0;
      for (const p of proxies) {
        const key = dedupKey(p, op.by);
        if (key == null) {
          out.push(p); // can't compute a key — never over-dedup
          continue;
        }
        if (!seen.has(key)) {
          seen.add(key);
          counts.set(key, 1);
          out.push(p);
          continue;
        }
        if (op.action === 'drop') {
          dropped += 1;
          continue;
        }
        // rename: keep but disambiguate with a running index
        const n = (counts.get(key) ?? 1) + 1;
        counts.set(key, n);
        changed += 1;
        out.push({ ...p, name: `${nameOf(p)} #${n}` });
      }
      return { proxies: out, dropped, changed };
    }

    case 'rename-template': {
      // Deterministic structured naming; per-node source identity (when
      // attached by the collection/single-sub caller) feeds the source +
      // per-source index placeholders. Never depends on a live AI call.
      const res = applyRenameTemplate(proxies, op, sourceOf, ordinalResolver);
      return {
        proxies: res.proxies,
        // True duplicates are REMOVED nodes — the trace must report them.
        dropped: proxies.length - res.proxies.length,
        changed: res.changed,
        // Collision names can embed raw residual text — bounded + redacted
        // at creation so every consumer (workbench, AI, preview) sees the
        // same projected shape (C10).
        collisions: res.collisions.map((c) => safeSampleName(c)),
        // Diagnostic provenance, projected through the same bounded
        // redaction as step samples (these entries flow into preview
        // responses and AI action results).
        deduped: res.deduped.map((d) => ({
          kept: safeSampleName(d.kept),
          dropped: safeSampleName(d.dropped),
          ...(d.sourceKey !== undefined ? { sourceKey: safeLabel(d.sourceKey) } : {}),
        })),
      };
    }

    case 'sort': {
      const dir = op.order === 'desc' ? -1 : 1;
      const keyed = proxies.map((p, i) => ({ p, i, k: sortKey(p, op.by) }));
      keyed.sort((a, b) => {
        const cmp = a.k.localeCompare(b.k, 'zh-Hans-CN', { numeric: true });
        return cmp !== 0 ? cmp * dir : a.i - b.i; // stable
      });
      return { proxies: keyed.map((x) => x.p), dropped: 0, changed: 0 };
    }

    default: {
      // Exhaustiveness guard — a new kind without a branch trips this.
      const _never: never = op;
      void _never;
      return { proxies, dropped: 0, changed: 0 };
    }
  }
}

function dedupKey(p: ClashProxy, by: 'name' | 'server-port'): string | null {
  if (by === 'name') {
    const n = nameOf(p);
    return n || null;
  }
  if (typeof p.server === 'string' && (typeof p.port === 'number' || typeof p.port === 'string')) {
    return `${p.server}:${p.port}`;
  }
  return null;
}

function sortKey(p: ClashProxy, by: 'name' | 'type' | 'server' | 'region'): string {
  if (by === 'name') return nameOf(p);
  if (by === 'type') return typeof p.type === 'string' ? p.type : '';
  if (by === 'server') return typeof p.server === 'string' ? p.server : '';
  // region: detected code, with unknowns sorted to the end via '~~'
  return detectRegion(nameOf(p)) ?? '~~';
}

/* ─── public API ───────────────────────────────────────────────────── */

/**
 * Run the full pipeline; returns transformed proxies + per-step trace.
 * `ordinalResolver` feeds the rename-template's persisted stable numbering
 * (serving paths inject it; pure/test callers omit it and fall back to
 * upstream ordinals / input order).
 */
export function applyOperators(
  input: ClashProxy[],
  operators: Operator[],
  ordinalResolver?: OrdinalResolver,
): ApplyResult {
  let proxies = input;
  const steps: OperatorStep[] = [];
  for (const op of operators) {
    const before = proxies.length;
    if (op.disabled) {
      steps.push({
        id: op.id,
        kind: op.kind,
        applied: false,
        before,
        after: before,
        dropped: 0,
        changed: 0,
      });
      continue;
    }
    const res = runOne(proxies, op, ordinalResolver);
    steps.push({
      id: op.id,
      kind: op.kind,
      applied: true,
      before,
      after: res.proxies.length,
      dropped: res.dropped,
      changed: res.changed,
      ...(res.collisions && res.collisions.length > 0 ? { collisions: res.collisions } : {}),
      ...(res.deduped && res.deduped.length > 0 ? { deduped: res.deduped } : {}),
      samples: stepSamples(proxies, res.proxies),
    });
    proxies = res.proxies;
  }
  return { proxies, steps };
}

/**
 * Convenience wrapper for the fetcher: take a normalised provider YAML
 * (`proxies:` block), run the pipeline, return re-serialised YAML + count.
 * No-ops (returns input) when there are no operators or no proxies array.
 */
export function applyOperatorsToProviderYaml(
  yaml: string,
  operators: Operator[],
): { yaml: string; proxyCount: number; steps: OperatorStep[] } {
  if (!operators || operators.length === 0) {
    return { yaml, proxyCount: countProxies(yaml), steps: [] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    return { yaml, proxyCount: countProxies(yaml), steps: [] };
  }
  const list = (parsed as { proxies?: unknown })?.proxies;
  if (!Array.isArray(list)) {
    return { yaml, proxyCount: 0, steps: [] };
  }
  const { proxies, steps } = applyOperators(list as ClashProxy[], operators);
  const out = stringifyYaml({ proxies }, { lineWidth: 0 });
  return { yaml: out, proxyCount: proxies.length, steps };
}

function countProxies(yaml: string): number {
  try {
    const parsed = parseYaml(yaml) as { proxies?: unknown };
    return Array.isArray(parsed?.proxies) ? parsed.proxies.length : 0;
  } catch {
    return 0;
  }
}
