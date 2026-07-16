import { isSafePattern } from 'redos-detector';

/**
 * User-controlled regular expressions run in the Node/V8 process for operator
 * previews and proxy-group membership previews. Keep both the program and its
 * input bounded: the detector protects against ambiguous backtracking while
 * the length limits prevent otherwise-linear patterns from processing an
 * unbounded subscription-provided node name.
 */
export const MAX_RUNTIME_REGEX_PATTERN_LENGTH = 512;
export const MAX_RUNTIME_REGEX_INPUT_LENGTH = 512;

const DETECTOR_OPTIONS = {
  maxScore: 200,
  maxSteps: 2_000,
  // A 25 ms wall-clock cutoff produced false rejects under ordinary parallel
  // test/server load; 100 ms keeps adversarial analysis bounded while the
  // deterministic maxSteps limit remains the primary work cap.
  timeout: 100,
} as const;

function detectorFlags(flags: string): {
  caseInsensitive: boolean;
  dotAll: boolean;
  multiLine: boolean;
  unicode: boolean;
} {
  const caseInsensitive = flags.includes('i');
  return {
    caseInsensitive,
    dotAll: flags.includes('s'),
    multiLine: flags.includes('m'),
    // redos-detector deliberately rejects the combination of its Unicode and
    // case-insensitive analysis modes. The V8 compilation above still checks
    // the real `/iu` program; analyse the same repetition/alternation shape in
    // non-Unicode mode when `i` is present instead of treating every ordinary
    // Mihomo `(?i)` filter as unsafe because the analyser threw.
    unicode: !caseInsensitive && (flags.includes('u') || flags.includes('v')),
  };
}

/**
 * ECMAScript Unicode IgnoreCase has folds that redos-detector cannot model
 * while it analyses an `i` pattern in non-Unicode mode. A literal Kelvin sign
 * is the obvious example, but a class range can hide it even when both written
 * endpoints are uncased (`[\u2100-\u2200]`). Reject those unsupported surfaces
 * before either compiling or analysing the pattern.
 */
function hasUnsupportedUnicodeIgnoreCasePattern(pattern: string): boolean {
  return (
    containsUnicodePropertyEscape(pattern) ||
    containsNonAsciiCasefulCodePoint(pattern) ||
    containsNonAsciiClassRange(pattern)
  );
}

/** A Unicode property class can contain case-folding code points not written in the source. */
function containsUnicodePropertyEscape(pattern: string): boolean {
  for (let index = 0; index < pattern.length; ) {
    if (pattern[index] !== '\\') {
      index += String.fromCodePoint(pattern.codePointAt(index) ?? 0).length;
      continue;
    }
    let end = index;
    while (pattern[end] === '\\') end += 1;
    const slashCount = end - index;
    if (
      slashCount % 2 === 1 &&
      (pattern[end] === 'p' || pattern[end] === 'P') &&
      pattern[end + 1] === '{'
    ) {
      return true;
    }
    index = end;
  }
  return false;
}

function containsNonAsciiCasefulCodePoint(pattern: string): boolean {
  for (let index = 0; index < pattern.length; ) {
    const atom = readPatternCodePoint(pattern, index);
    if (atom === null) {
      index += 1;
      continue;
    }
    if (atom.escapedBackslash) {
      index += atom.width;
      continue;
    }
    if (atom.codePoint !== null) {
      const value = String.fromCodePoint(atom.codePoint);
      if (atom.codePoint > 0x7f && value.toLowerCase() !== value.toUpperCase()) {
        return true;
      }
    }
    index += atom.width;
  }
  return false;
}

interface PatternCodePoint {
  codePoint: number | null;
  width: number;
  /** `\\\\` denotes a literal backslash; its following ASCII text is not an escape. */
  escapedBackslash: boolean;
}

/** Read one literal/hex-escaped code point, including an escaped surrogate pair. */
function readPatternCodePoint(pattern: string, index: number): PatternCodePoint | null {
  if (pattern[index] !== '\\') {
    const codePoint = pattern.codePointAt(index);
    if (codePoint === undefined) return null;
    return {
      codePoint,
      width: String.fromCodePoint(codePoint).length,
      escapedBackslash: false,
    };
  }

  if (pattern[index + 1] === '\\') {
    return { codePoint: 0x5c, width: 2, escapedBackslash: true };
  }

  // ECMAScript accepts more than six written hex digits when the additional
  // digits are leading zeroes (for example `\\u{000212A}`). Capture the whole
  // token and validate its numeric value instead of imposing a source-width
  // limit, otherwise a case-folding code point can hide behind those zeroes.
  const braced = /^\\u\{([0-9A-Fa-f]+)\}/u.exec(pattern.slice(index));
  if (braced) {
    const codePoint = Number.parseInt(braced[1], 16);
    return {
      codePoint: codePoint <= 0x10_ffff ? codePoint : null,
      width: braced[0].length,
      escapedBackslash: false,
    };
  }

  const unicode = /^\\u([0-9A-Fa-f]{4})/u.exec(pattern.slice(index));
  if (unicode) {
    const first = Number.parseInt(unicode[1], 16);
    let codePoint = first;
    let width = unicode[0].length;
    if (first >= 0xd800 && first <= 0xdbff) {
      const low = /^\\u([0-9A-Fa-f]{4})/u.exec(pattern.slice(index + width));
      if (low) {
        const second = Number.parseInt(low[1], 16);
        if (second >= 0xdc00 && second <= 0xdfff) {
          codePoint = 0x1_0000 + ((first - 0xd800) << 10) + (second - 0xdc00);
          width += low[0].length;
        }
      }
    }
    return { codePoint, width, escapedBackslash: false };
  }

  const hexadecimal = /^\\x([0-9A-Fa-f]{2})/u.exec(pattern.slice(index));
  if (hexadecimal) {
    return {
      codePoint: Number.parseInt(hexadecimal[1], 16),
      width: hexadecimal[0].length,
      escapedBackslash: false,
    };
  }

  const next = pattern.codePointAt(index + 1);
  if (next === undefined) return { codePoint: null, width: 1, escapedBackslash: false };
  return {
    codePoint: next,
    width: 1 + String.fromCodePoint(next).length,
    escapedBackslash: false,
  };
}

interface ClassToken {
  kind: 'atom' | 'hyphen';
  codePoint: number | null;
}

/**
 * Reject a character-class range if either written endpoint is non-ASCII.
 * Such a range may contain case-folding code points that never appear in the
 * source text, so checking only written literals is insufficient.
 */
function containsNonAsciiClassRange(pattern: string): boolean {
  for (let start = 0; start < pattern.length; start += 1) {
    if (pattern[start] === '\\') {
      start += 1;
      continue;
    }
    if (pattern[start] !== '[') continue;

    const tokens: ClassToken[] = [];
    let index = start + 1;
    if (pattern[index] === '^') index += 1;
    for (; index < pattern.length; ) {
      if (pattern[index] === ']') break;
      if (pattern[index] === '-') {
        tokens.push({ kind: 'hyphen', codePoint: 0x2d });
        index += 1;
        continue;
      }
      const atom = readPatternCodePoint(pattern, index);
      if (atom === null) {
        index += 1;
        continue;
      }
      tokens.push({ kind: 'atom', codePoint: atom.codePoint });
      index += atom.width;
    }

    for (let tokenIndex = 1; tokenIndex < tokens.length - 1; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      const left = tokens[tokenIndex - 1];
      const right = tokens[tokenIndex + 1];
      if (
        token.kind === 'hyphen' &&
        left.kind === 'atom' &&
        right.kind === 'atom' &&
        ((left.codePoint ?? 0) > 0x7f || (right.codePoint ?? 0) > 0x7f)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Return false for malformed, oversized, ambiguous, timed-out, or unsupported patterns. */
export function isSafeRuntimeRegex(pattern: string, flags = ''): boolean {
  if (
    pattern.length === 0 ||
    pattern.length > MAX_RUNTIME_REGEX_PATTERN_LENGTH ||
    flags.length > 8
  ) {
    return false;
  }
  // redos-detector cannot model UnicodeSets together with IgnoreCase. In
  // particular, a `\q{a|aa}` string class can hide exponential ambiguity, so
  // fail closed on the whole currently-unused combination.
  if (flags.includes('i') && flags.includes('v')) return false;
  if (
    flags.includes('i') &&
    flags.includes('u') &&
    hasUnsupportedUnicodeIgnoreCasePattern(pattern)
  ) {
    return false;
  }
  try {
    // Compile first: the detector can downgrade constructs that the current JS
    // runtime itself does not accept, which must not turn an invalid pattern
    // into an accepted one.
    new RegExp(pattern, flags);
    // The JS engine's unanchored search adds at most one bounded scan across
    // the (also bounded) input. Analyse one start position so ordinary linear
    // patterns such as `\s*01$` are not misclassified solely because they are
    // unanchored; ambiguous quantified bodies remain unsafe after wrapping.
    const analysisPattern = pattern.startsWith('^') ? pattern : `^(?:${pattern})`;
    const result = isSafePattern(analysisPattern, {
      ...DETECTOR_OPTIONS,
      ...detectorFlags(flags),
    });
    return result.safe && result.error === null;
  } catch {
    return false;
  }
}

/** Compile a pattern only after the same fail-closed checks used by write schemas. */
export function compileSafeRuntimeRegex(pattern: string, flags = ''): RegExp {
  if (!isSafeRuntimeRegex(pattern, flags)) {
    throw new Error('Unsafe or invalid regular expression.');
  }
  return new RegExp(pattern, flags);
}

/** Reject remote-controlled node names before running any user regex on them. */
export function assertSafeRuntimeRegexInput(input: string): void {
  if (input.length > MAX_RUNTIME_REGEX_INPUT_LENGTH) {
    throw new Error('Regular-expression input exceeds the supported length.');
  }
}
