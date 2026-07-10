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
import { detectRegion, flagFromCode, regionByCode, stripFlags } from './regions';

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

function buildUselessRe(extra: string[]): RegExp {
  // The schema (uselessExtraPattern) already rejects fragments that don't
  // compile or match the empty string, but legacy operators stored before that
  // guard existed can still carry a bad fragment. Wrap each user fragment in a
  // non-capturing group (so its internal `|` can't spill into a sibling branch)
  // and drop any that fail to compile standalone — a malformed junk filter must
  // degrade to "filter fewer nodes", never throw and 500 the whole render.
  const safeExtra: string[] = [];
  for (const e of extra) {
    if (e.trim().length === 0) continue;
    try {
      new RegExp(e); // standalone compile check
      if (new RegExp(e).test('')) continue; // empty-matching → would drop everything
      safeExtra.push(`(?:${e})`);
    } catch {
      // skip the malformed fragment
    }
  }
  const parts = [...USELESS_PATTERNS, ...safeExtra];
  try {
    return new RegExp(parts.join('|'), 'i');
  } catch {
    // Last-resort fallback: built-ins only (they are known-good literals).
    return new RegExp(USELESS_PATTERNS.join('|'), 'i');
  }
}

/** Compile a user regex; `test`-safe (no sticky/global state leakage). */
function compileTest(pattern: string, flags?: string): RegExp {
  const f = (flags ?? 'i').replace(/[gy]/g, ''); // test() must be stateless
  return new RegExp(pattern, f);
}

/* ─── per-operator transforms ──────────────────────────────────────── */

function runOne(
  proxies: ClashProxy[],
  op: Operator,
): { proxies: ClashProxy[]; dropped: number; changed: number } {
  const before = proxies.length;

  switch (op.kind) {
    case 'filter-regex': {
      const re = compileTest(op.pattern, op.flags);
      const kept = proxies.filter((p) => {
        const hit = re.test(nameOf(p));
        return op.mode === 'keep' ? hit : !hit;
      });
      return { proxies: kept, dropped: before - kept.length, changed: 0 };
    }

    case 'filter-useless': {
      const re = buildUselessRe(op.extra ?? []);
      const kept = proxies.filter((p) => !re.test(nameOf(p)));
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
      const re = new RegExp(op.pattern, op.flags ?? 'g');
      let changed = 0;
      const out = proxies.map((p) => {
        const name = nameOf(p);
        if (!name) return p;
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
        if (
          op.skipCertVerify !== undefined &&
          p['skip-cert-verify'] !== op.skipCertVerify
        ) {
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

/** Run the full pipeline; returns transformed proxies + per-step trace. */
export function applyOperators(input: ClashProxy[], operators: Operator[]): ApplyResult {
  let proxies = input;
  const steps: OperatorStep[] = [];
  for (const op of operators) {
    const before = proxies.length;
    if (op.disabled) {
      steps.push({ id: op.id, kind: op.kind, applied: false, before, after: before, dropped: 0, changed: 0 });
      continue;
    }
    const res = runOne(proxies, op);
    proxies = res.proxies;
    steps.push({
      id: op.id,
      kind: op.kind,
      applied: true,
      before,
      after: proxies.length,
      dropped: res.dropped,
      changed: res.changed,
    });
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
