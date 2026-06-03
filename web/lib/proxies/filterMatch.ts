/**
 * Resolve a mihomo proxy-group `filter` (+ optional `exclude-filter`) against
 * a list of node names — the shared source of truth for both the client-side
 * membership preview and the assistant's `preview_proxy_group_members` tool.
 *
 * Semantics mirror mihomo: `filter` is an unanchored regex on the node name;
 * matches are kept, then `exclude-filter` matches are dropped. An invalid
 * pattern is reported as an error string instead of throwing, so callers can
 * surface it inline rather than crashing.
 */

export interface FilterMatch {
  matched: string[];
  error: string | null;
}

/**
 * Compile a mihomo (Go RE2) filter for use with JS RegExp. Go supports a
 * leading inline flag group like `(?i)` / `(?is)` that JS doesn't accept in
 * the pattern body — lift it into JS RegExp flags so the preview matches what
 * mihomo computes. Unsupported Go-only flags are dropped.
 */
export function compileGoRegex(pattern: string): RegExp {
  let body = pattern;
  let flags = '';
  const m = /^\(\?([a-zA-Z]+)\)/.exec(body);
  if (m) {
    for (const f of m[1]) if ('ism'.includes(f) && !flags.includes(f)) flags += f;
    body = body.slice(m[0].length);
  }
  return new RegExp(body, flags);
}

/**
 * Compute which node names a `filter` (+ optional `exclude-filter`) keeps.
 * Returns an error string for an invalid regex instead of throwing.
 */
export function matchFilter(
  nodeNames: string[],
  filter?: string,
  excludeFilter?: string,
): FilterMatch {
  let inc: RegExp | null = null;
  let exc: RegExp | null = null;
  try {
    if (filter && filter.trim()) inc = compileGoRegex(filter);
    if (excludeFilter && excludeFilter.trim()) exc = compileGoRegex(excludeFilter);
  } catch (e) {
    return { matched: [], error: e instanceof Error ? e.message : '正则无效' };
  }
  const matched = nodeNames.filter((n) => {
    if (inc && !inc.test(n)) return false;
    if (exc && exc.test(n)) return false;
    return true;
  });
  return { matched, error: null };
}
