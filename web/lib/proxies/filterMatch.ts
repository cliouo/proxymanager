import { assertSafeRuntimeRegexInput, compileSafeRuntimeRegex } from './regexSafety';

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
 * Compile the product-supported, ReDoS-checked ECMAScript-compatible subset of
 * Mihomo v1.19.28's dlclark/regexp2 syntax for use in the JS preview. A leading
 * inline flag group like `(?i)` / `(?is)` is lifted into JS RegExp flags.
 */
export function compileGoRegex(pattern: string, baseFlags = ''): RegExp {
  let body = pattern;
  let flags = '';
  if ([...baseFlags].some((flag) => !'ism'.includes(flag))) {
    throw new Error('正则包含不受支持的基础 flag');
  }
  for (const flag of baseFlags) if (!flags.includes(flag)) flags += flag;
  const m = /^\(\?([a-zA-Z]+)\)/.exec(body);
  if (m) {
    if ([...m[1]].some((flag) => !'ism'.includes(flag))) {
      throw new Error('正则包含不受支持的内联 flag');
    }
    for (const f of m[1]) if (!flags.includes(f)) flags += f;
    body = body.slice(m[0].length);
  }
  // regexp2 uses Unicode character classes while ECMAScript keeps \w/\d/\b
  // ASCII-oriented even under /u. Accepting those would make preview and the
  // final dependency graph disagree. Callers can express exact boundaries via
  // explicit classes/lookarounds, e.g. (?<![A-Za-z])US(?![A-Za-z]).
  if (/\\[bBdDsSwWpP]/u.test(body)) {
    throw new Error('正则包含 JS 与 Mihomo 语义不一致的字符类或边界');
  }
  // ECMAScript /u accepts code-point escapes such as `\\u{1F600}`, while the
  // fixed regexp2 parser treats them as malformed hexadecimal escapes.
  if (body.includes('\\u{')) {
    throw new Error('正则包含 fixed Mihomo regexp2 不支持的 Unicode code-point escape');
  }
  // ECMAScript treats [] / [^] as valid never/any classes, while fixed
  // dlclark/regexp2 rejects both as an unterminated set. Detect only unescaped
  // opening brackets so literal `\\[\\]` remains valid.
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\') {
      index += 1;
      continue;
    }
    if (
      body[index] === '[' &&
      (body[index + 1] === ']' || (body[index + 1] === '^' && body[index + 2] === ']'))
    ) {
      throw new Error('正则包含 fixed Mihomo regexp2 不接受的空字符类');
    }
  }
  // With /u, dot and quantifiers operate on Unicode code points like regexp2,
  // rather than splitting an emoji into two UTF-16 surrogate halves.
  if (!flags.includes('u')) flags += 'u';
  return compileSafeRuntimeRegex(body, flags);
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
  let inc: RegExp[] = [];
  let exc: RegExp[] = [];
  try {
    if (filter && filter.trim()) {
      inc = filter.split('`').map((pattern) => compileGoRegex(pattern));
    }
    if (excludeFilter && excludeFilter.trim()) {
      exc = excludeFilter.split('`').map((pattern) => compileGoRegex(pattern));
    }
    for (const name of nodeNames) assertSafeRuntimeRegexInput(name);
  } catch (e) {
    return { matched: [], error: e instanceof Error ? e.message : '正则无效' };
  }
  const matched = nodeNames.filter((n) => {
    if (inc.length > 0 && !inc.some((re) => re.test(n))) return false;
    if (exc.some((re) => re.test(n))) return false;
    return true;
  });
  return { matched, error: null };
}
