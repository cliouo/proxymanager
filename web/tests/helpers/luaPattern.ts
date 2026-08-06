/**
 * Faithful Lua 5.1 PATTERN (not regex) matcher — the strongest safe semantic
 * substitute available on this machine (no lua/luajit/redis-server, no
 * fengari/wasmoon, no lupa — probed; installing any of them is forbidden by
 * the task). It exists to prove the PRODUCTION Lua scripts use Lua-VALID
 * canonical-decimal patterns: Lua patterns have NO alternation (`|` inside a
 * pattern is a LITERAL character), no `\d`, and `()` is a capture — a
 * JavaScript-style `^(0|[1-9][0-9]*)$` therefore matches `0|1` and REJECTS
 * `1` inside real Lua. The engine implements the Lua 5.1 pattern subset the
 * scripts use (anchors, `.`, classes with ranges/negation/`%`-escapes,
 * quantifiers `*`/`+`/`-`/`?`, non-nested captures) and is conformance-tested
 * against the Lua 5.1 manual semantics.
 */

type Item =
  | { kind: 'literal'; ch: string }
  | { kind: 'any' } // .
  | { kind: 'class'; negated: boolean; ranges: Array<[number, number]> }
  | { kind: 'capture-open' }
  | { kind: 'capture-close' };

interface Parsed {
  anchoredStart: boolean;
  anchoredEnd: boolean;
  items: Array<
    Item | { kind: 'quantified'; item: Item; min: number; max: number; greedy: boolean }
  >;
}

const CLASS_ESCAPES: Record<string, string> = {
  a: 'letters',
  c: 'control',
  d: 'digits',
  l: 'lower',
  p: 'punct',
  s: 'space',
  u: 'upper',
  w: 'alnum',
  x: 'hex',
  z: '\\0',
};

function escapeSet(name: string): Array<[number, number]> {
  switch (name) {
    case 'd':
      return [[48, 57]];
    case 's':
      return [
        [9, 13],
        [32, 32],
      ];
    case 'w':
      return [
        [48, 57],
        [65, 90],
        [97, 122],
      ];
    case 'a':
      return [
        [65, 90],
        [97, 122],
      ];
    case 'l':
      return [[97, 122]];
    case 'u':
      return [[65, 90]];
    case 'x':
      return [
        [48, 57],
        [65, 70],
        [97, 102],
      ];
    case 'c':
      return [[0, 31]];
    case 'p':
      return [
        [33, 47],
        [58, 64],
        [91, 96],
        [123, 126],
      ];
    case 'z':
      return [[0, 0]];
    default:
      throw new Error(`unsupported pattern escape %${name}`);
  }
}

function parseClass(body: string): { negated: boolean; ranges: Array<[number, number]> } {
  let i = 0;
  let negated = false;
  if (body[0] === '^') {
    negated = true;
    i = 1;
  }
  const ranges: Array<[number, number]> = [];
  let prev: number | null = null;
  while (i < body.length) {
    const ch = body[i];
    if (ch === ']' && i === 0) {
      ranges.push([93, 93]);
      i += 1;
      continue;
    }
    if (ch === '%' && i + 1 < body.length) {
      const esc = body[i + 1];
      if (esc in CLASS_ESCAPES) {
        for (const [lo, hi] of escapeSet(esc)) ranges.push([lo, hi]);
      } else {
        ranges.push([esc.charCodeAt(0), esc.charCodeAt(0)]);
      }
      prev = null;
      i += 2;
      continue;
    }
    if (ch === '-' && i + 1 < body.length && body[i + 1] !== ']' && prev !== null) {
      const lo = prev;
      i += 1;
      const hi = body[i];
      if (lo <= hi.charCodeAt(0)) ranges.push([lo, hi.charCodeAt(0)]);
      else throw new Error('invalid pattern: class range reversed');
      prev = null;
      i += 1;
      continue;
    }
    ranges.push([ch.charCodeAt(0), ch.charCodeAt(0)]);
    prev = ch.charCodeAt(0);
    i += 1;
  }
  return { negated, ranges };
}

function matchesClass(
  cls: { negated: boolean; ranges: Array<[number, number]> },
  ch: string,
): boolean {
  const code = ch.charCodeAt(0);
  const inRange = cls.ranges.some(([lo, hi]) => code >= lo && code <= hi);
  return cls.negated ? !inRange : inRange;
}

/** Parse a Lua 5.1 pattern. Captures must be non-nested (enough for every
 * production script pattern; nested captures throw). */
function parsePattern(pattern: string): Parsed {
  const anchoredStart = pattern.startsWith('^');
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd
    ? pattern.slice(anchoredStart ? 1 : 0, -1)
    : pattern.slice(anchoredStart ? 1 : 0);
  const items: Array<
    Item | { kind: 'quantified'; item: Item; min: number; max: number; greedy: boolean }
  > = [];
  let captureDepth = 0;
  let j = 0;
  while (j < body.length) {
    const ch = body[j];
    let item: Item;
    if (ch === '(') {
      captureDepth += 1;
      if (captureDepth > 1) throw new Error('nested captures unsupported');
      item = { kind: 'capture-open' };
      j += 1;
    } else if (ch === ')') {
      captureDepth -= 1;
      if (captureDepth < 0) throw new Error('unmatched ) in pattern');
      item = { kind: 'capture-close' };
      j += 1;
    } else if (ch === '.') {
      item = { kind: 'any' };
      j += 1;
    } else if (ch === '%') {
      if (j + 1 >= body.length) throw new Error('dangling % in pattern');
      const esc = body[j + 1];
      if (esc in CLASS_ESCAPES) {
        item = { kind: 'class', negated: false, ranges: escapeSet(esc) };
      } else {
        item = { kind: 'literal', ch: esc };
      }
      j += 2;
    } else if (ch === '[') {
      let close = j + 1;
      let depth = 0;
      while (close < body.length) {
        if (body[close] === '[') depth += 1;
        else if (body[close] === ']') {
          if (depth === 0) break;
          depth -= 1;
        }
        close += 1;
      }
      if (close >= body.length) throw new Error('unmatched [ in pattern');
      const cls = parseClass(body.slice(j + 1, close));
      item = { kind: 'class', negated: cls.negated, ranges: cls.ranges };
      j = close + 1;
    } else if (ch === '^' || ch === '$') {
      // mid-pattern anchors are literal in Lua
      item = { kind: 'literal', ch };
      j += 1;
    } else if (ch === '*') {
      throw new Error('quantifier without item');
    } else {
      item = { kind: 'literal', ch };
      j += 1;
    }

    // quantifier?
    const q = body[j];
    if (q === '*' || q === '+' || q === '-' || q === '?') {
      if (item.kind === 'capture-open' || item.kind === 'capture-close') {
        throw new Error('quantifier on capture unsupported');
      }
      let min: number;
      let max: number;
      let greedy: boolean;
      if (q === '*') {
        min = 0;
        max = Infinity;
        greedy = true;
      } else if (q === '+') {
        min = 1;
        max = Infinity;
        greedy = true;
      } else if (q === '-') {
        min = 0;
        max = Infinity;
        greedy = false;
      } else {
        min = 0;
        max = 1;
        greedy = true;
      }
      items.push({ kind: 'quantified', item, min, max, greedy });
      j += 1;
    } else {
      items.push(item);
    }
  }
  if (captureDepth !== 0) throw new Error('unmatched ( in pattern');
  return { anchoredStart, anchoredEnd, items };
}

function matchAt(subject: string, start: number, items: Parsed['items']): number | null {
  // backtracking matcher; returns the end index (exclusive) or null
  const tryFrom = (pos: number, idx: number): number | null => {
    if (idx === items.length) return pos;
    const item = items[idx];
    if (item.kind === 'capture-open') {
      return tryFrom(pos, idx + 1);
    }
    if (item.kind === 'capture-close') {
      return tryFrom(pos, idx + 1);
    }
    const next = (end: number): number | null => tryFrom(end, idx + 1);
    if (item.kind === 'quantified') {
      const { item: base, min, max, greedy } = item;
      const count = (end: number): number => {
        let n = 0;
        let p = end;
        for (;;) {
          if (n >= max) break;
          const ch = subject[p];
          if (ch === undefined) break;
          let ok = false;
          if (base.kind === 'any') ok = ch !== '\n';
          else if (base.kind === 'literal') ok = ch === base.ch;
          else if (base.kind === 'class') ok = matchesClass(base, ch);
          else throw new Error('quantified capture unsupported');
          if (!ok) break;
          n += 1;
          p += 1;
        }
        return n;
      };
      const maxCount = count(pos);
      if (greedy) {
        for (let take = maxCount; take >= min; take -= 1) {
          const result = next(pos + take);
          if (result !== null) return result;
        }
        return null;
      }
      // non-greedy: try 0 first, then grow
      for (let take = 0; take <= maxCount; take += 1) {
        if (take < min) continue;
        const result = next(pos + take);
        if (result !== null) return result;
      }
      return null;
    }
    const ch = subject[pos];
    if (ch === undefined) return null;
    let ok = false;
    if (item.kind === 'any') ok = ch !== '\n';
    else if (item.kind === 'literal') ok = ch === item.ch;
    else ok = matchesClass(item, ch);
    if (!ok) return null;
    return next(pos + 1);
  };
  return tryFrom(start, 0);
}

/**
 * Lua 5.1 `string.match(subject, pattern)` semantics for the supported
 * subset: returns the matched substring (first match from position 1) or
 * null. Unanchored patterns search forward; the scripts' patterns are all
 * anchored with ^ and $.
 */
export function luaMatch(subject: string, pattern: string): string | null {
  const parsed = parsePattern(pattern);
  const body = parsed.items;
  if (parsed.anchoredStart) {
    const end = matchAt(subject, 0, body);
    if (end === null) return null;
    const match = subject.slice(0, end);
    return parsed.anchoredEnd && end !== subject.length ? null : match;
  }
  for (let pos = 0; pos <= subject.length; pos += 1) {
    const end = matchAt(subject, pos, body);
    if (end === null) continue;
    const match = subject.slice(pos, end);
    if (parsed.anchoredEnd && end !== subject.length) continue;
    return match;
  }
  return null;
}
