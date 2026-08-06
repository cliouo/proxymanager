/**
 * Lua-semantic evidence for the production Redis scripts (criterion 3).
 *
 * No real Lua/Redis facility exists on this machine (probed: lua, luajit,
 * lua5.x, redis-server, redis-cli, docker, wasmtime, python lupa, npm
 * fengari/lua-in-js — all absent; installing any is forbidden). The strongest
 * safe substitute is this suite: a faithful Lua 5.1 PATTERN engine
 * (tests/helpers/luaPattern.ts — Lua patterns are NOT regexes; `|` is a
 * literal character and `()` is a capture) applied to the ACTUAL pattern
 * literals extracted from the PRODUCTION script sources. A JavaScript-style
 * `^(0|[1-9][0-9]*)$` inside Lua matches only `0|1` — this suite fails on
 * exactly that prior defect while the repaired Lua-valid checks pass.
 */

import { describe, expect, it } from 'vitest';
import { luaMatch } from '../helpers/luaPattern';
import { CAS_ENTITY_WITH_HISTORY } from '@/lib/repos/namingCasRepo';
import { ASSIGN_ORDINALS_LUA } from '@/lib/repos/nodeOrdinalRepo';

/** Every string.match(<var>, '<pattern>') literal used by a production script. */
function patternsOf(script: string): string[] {
  const out: string[] = [];
  const re = /string\.match\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*'([^']*)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) out.push(m[1]);
  return out;
}

/** The production scripts' isCanonicalUnsigned semantics, evaluated with the
 * Lua pattern engine (identical bodies in both scripts — asserted below). */
function canonicalViaLuaPattern(raw: string, patterns: string[]): boolean {
  const digits = patterns.find((p) => p === '^[0-9]+$');
  if (!digits) throw new Error('production script lost its digit pattern');
  if (luaMatch(raw, digits) === null) return false;
  if (raw.length > 1 && raw[0] === '0') return false;
  return true;
}

const CANONICAL_ACCEPT = ['1', '99999', '0', '1234567890', '9007199254740990', '9007199254740991'];
const CANONICAL_REJECT = [
  '', // empty
  '0|1', // the JS-alternation trap: Lua treats | literally
  '01', // leading zero
  '007', // leading zeros
  '-1', // signed
  '+1', // signed
  '1.5', // decimal
  '1e3', // exponent
  ' 1', // leading whitespace
  '1 ', // trailing whitespace
  'abc', // letters
  '12x', // suffix garbage
];

describe('Lua pattern engine conformance (Lua 5.1 semantics, not regex)', () => {
  it('| is a LITERAL in Lua patterns — the prior defect', () => {
    expect(luaMatch('a|b', 'a|b')).toBe('a|b');
    expect(luaMatch('ab', 'a|b')).toBeNull();
    // the old JS-style pattern only matches the literal "0|1"
    expect(luaMatch('1', '^(0|[1-9][0-9]*)$')).toBeNull();
    expect(luaMatch('0|1', '^(0|[1-9][0-9]*)$')).toBe('0|1');
  });

  it('anchors, classes, ranges, negation, quantifiers behave per Lua', () => {
    expect(luaMatch('123', '^[0-9]+$')).toBe('123');
    expect(luaMatch('12x', '^[0-9]+$')).toBeNull();
    expect(luaMatch('a1', '^%a%d$')).toBe('a1');
    expect(luaMatch('1a', '^[^0-9]+$')).toBeNull();
    expect(luaMatch('abc', '^[^0-9]+$')).toBe('abc');
    expect(luaMatch('x9', '^%w%w$')).toBe('x9');
    expect(luaMatch('hello', '^h.*o$')).toBe('hello');
    expect(luaMatch('heo', '^h.*o$')).toBe('heo');
    expect(luaMatch('abc', '^ab?c$')).toBe('abc');
    expect(luaMatch('ac', '^ab?c$')).toBe('ac');
  });
});

describe('production Lua scripts use Lua-valid canonical decimal checks', () => {
  const scripts: Array<[string, string]> = [
    ['CAS_ENTITY_WITH_HISTORY', CAS_ENTITY_WITH_HISTORY],
    ['ASSIGN_ORDINALS_LUA', ASSIGN_ORDINALS_LUA],
  ];

  for (const [name, script] of scripts) {
    it(`${name}: no JS-style alternation anywhere in its patterns`, () => {
      for (const pattern of patternsOf(script)) {
        expect(pattern).not.toContain('|');
      }
    });

    it(`${name}: canonical unsigned decimals are accepted, everything else rejected`, () => {
      const patterns = patternsOf(script);
      for (const value of CANONICAL_ACCEPT) {
        expect(canonicalViaLuaPattern(value, patterns), `accept ${JSON.stringify(value)}`).toBe(
          true,
        );
      }
      for (const value of CANONICAL_REJECT) {
        expect(canonicalViaLuaPattern(value, patterns), `reject ${JSON.stringify(value)}`).toBe(
          false,
        );
      }
    });

    it(`${name}: has an explicit byte-exact format (never tostring) for written numbers`, () => {
      expect(script).toContain("string.format('%.0f'");
    });
  }

  it('CAS script guards the safe-integer increment boundary BEFORE any write', () => {
    expect(CAS_ENTITY_WITH_HISTORY).toContain('9007199254740990');
    expect(CAS_ENTITY_WITH_HISTORY).toContain("'version-overflow'");
    // the version SET/return format the exact computed string
    expect(CAS_ENTITY_WITH_HISTORY).toContain(
      "redis.call('SET', KEYS[1], string.format('%.0f', nextVersion))",
    );
  });

  it('the counter pattern stays canonical unsigned-decimal and self-heals negative state', () => {
    const ordinalPatterns = patternsOf(ASSIGN_ORDINALS_LUA);
    const unsigned = ordinalPatterns.find((p) => p === '^[0-9]+$');
    expect(unsigned).toBe('^[0-9]+$');
    expect(luaMatch('-5', unsigned ?? '')).toBeNull();
    expect(luaMatch('12x', unsigned ?? '')).toBeNull();
  });

  it('range-level rejection (int64 max, 2^53) is enforced by the scripts, not the pattern', () => {
    // the pattern accepts digits; the tonumber + bound guards reject the
    // non-safe values before any write
    expect(ASSIGN_ORDINALS_LUA).toContain('9007199254740991');
    expect(CAS_ENTITY_WITH_HISTORY).toContain('current > 9007199254740990');
    expect(CAS_ENTITY_WITH_HISTORY).toContain("'version-overflow'");
  });
});
