/**
 * sourceAliasResolver strictness (pass-6 blocker 2): external alias payloads
 * are src-handle-only; plain stable keys, mixed forms, invented handles,
 * MAC collisions and duplicate-after-translation all fail with ONE bounded,
 * insertion-order-independent error — no writes happen anywhere.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@/lib/http/problem';
import { injectHandleSignerForTests, resetHandleSecret } from '@/lib/proxies/handles';
import { installTestHandleSecret, TEST_HANDLE_SECRET } from '../helpers/handleSecret';
import {
  assertExternalAliasKeys,
  projectAliasKeysToHandles,
  resolveSourceAliasKeys,
} from '@/lib/services/sourceAliasResolver';
import { buildOpaqueSourceIndexFromKeys } from '@/lib/ai/namingAnalysis';

beforeAll(() => {
  installTestHandleSecret();
});

afterEach(() => {
  resetHandleSecret();
  installTestHandleSecret();
});

const KEYS = ['airport-a', 'airport-b'];
let HANDLE_A = '';
let HANDLE_B = '';
beforeAll(() => {
  const index = buildOpaqueSourceIndexFromKeys(KEYS);
  HANDLE_A = index.keyToId.get('airport-a') as string;
  HANDLE_B = index.keyToId.get('airport-b') as string;
});

describe('pass-6 strict external alias contract', () => {
  it('plain stable keys, mixed forms and s0/s1-style keys are rejected — order-independent', () => {
    // plain stable-only
    expect(() => resolveSourceAliasKeys({ 'airport-a': 'x' }, KEYS)).toThrowError(
      ProblemDetailsError,
    );
    // mixed plain + src — BOTH insertion orders
    expect(() => resolveSourceAliasKeys({ 'airport-a': 'x', [HANDLE_B]: 'y' }, KEYS)).toThrowError(
      ProblemDetailsError,
    );
    expect(() => resolveSourceAliasKeys({ [HANDLE_B]: 'y', 'airport-a': 'x' }, KEYS)).toThrowError(
      ProblemDetailsError,
    );
    // ordinal s0-style keys are rejected like any plain key
    expect(() => resolveSourceAliasKeys({ s0: 'x' }, KEYS)).toThrowError(ProblemDetailsError);
    // assertExternalAliasKeys agrees
    expect(() => assertExternalAliasKeys({ 'airport-a': 'x' })).toThrowError(ProblemDetailsError);
    expect(() => assertExternalAliasKeys({ s1: 'x' })).toThrowError(ProblemDetailsError);
  });

  it('invented (format-valid, unmapped) handles and MAC collisions fail closed', () => {
    expect(() => resolveSourceAliasKeys({ 'src-0000000000000000': 'x' }, KEYS)).toThrowError(
      ProblemDetailsError,
    );
    // forced source-MAC collision: two DISTINCT keys share one handle
    injectHandleSignerForTests({ mac: () => '0000000000000000' });
    expect(() => resolveSourceAliasKeys({ 'src-0000000000000000': 'x' }, KEYS)).toThrowError(
      ProblemDetailsError,
    );
    expect(() => buildOpaqueSourceIndexFromKeys(['a', 'b'])).toThrowError(/collision/);
  });

  it('duplicate-after-translation / ambiguous targets collapse into the SAME bounded failure (order-independent)', () => {
    // under the collision seam two DISTINCT stable keys share one handle —
    // a translated alias would be ambiguous; the resolver fails closed
    injectHandleSignerForTests({ mac: () => '0000000000000000' });
    expect(() => resolveSourceAliasKeys({ 'src-0000000000000000': 'x' }, ['a', 'b'])).toThrowError(
      ProblemDetailsError,
    );
    // with real MACs every stable key has exactly ONE handle, so a second
    // entry for the same target is either invented or a collision — both
    // fail identically
    resetHandleSecret();
    installTestHandleSecret();
    expect(() => resolveSourceAliasKeys({ 'src-1111111111111111': 'x' }, KEYS)).toThrowError(
      ProblemDetailsError,
    );
  });

  it('authorized src-only aliases translate exactly once; read projection round-trips', () => {
    const resolved = resolveSourceAliasKeys({ [HANDLE_A]: '改名机场' }, KEYS);
    expect(resolved).toEqual({ 'airport-a': '改名机场' });
    // the read projection maps stored stable keys back to the SAME handles
    const projected = projectAliasKeysToHandles(resolved, KEYS);
    expect(projected).toEqual({ [HANDLE_A]: '改名机场' });
    // deterministic under the fixed test key
    expect(TEST_HANDLE_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe('pass-8 blocker 1: TOTAL fail-closed read projection', () => {
  it('orphan / renamed / disabled / deleted stable keys are DROPPED — never returned verbatim', () => {
    // stored aliases referencing keys NOT in the current authoritative set
    const stored = {
      'airport-a': '在册',
      'airport-renamed': '旧名',
      'airport-disabled': '停用',
      'airport-deleted': '已删',
    };
    const projected = projectAliasKeysToHandles(stored, KEYS);
    expect(projected).toEqual({ [HANDLE_A]: '在册' });
    // no stable key escapes the projection
    const blob = JSON.stringify(projected);
    for (const raw of Object.keys(stored)) expect(blob).not.toContain(raw);
  });

  it('src-like / ref-like / UUID-like / s0-style stored keys are DROPPED too', () => {
    const stored = {
      'src-0123456789abcdef': '伪造句柄',
      'ref-0123456789abcdef': '引用样',
      '01234567-0123-4123-8123-0123456789ab': 'uuid样',
      s0: '序号样',
    };
    const projected = projectAliasKeysToHandles(stored, KEYS);
    expect(projected).toEqual({});
    expect(JSON.stringify(projected)).not.toContain('src-');
    expect(JSON.stringify(projected)).not.toContain('ref-');
    expect(JSON.stringify(projected)).not.toContain('01234567');
  });

  it('a source-MAC collision inside the authoritative set fails the projection closed (bounded)', () => {
    injectHandleSignerForTests({ mac: () => '0000000000000000' });
    try {
      expect(() => projectAliasKeysToHandles({ a: 'x' }, ['a', 'b'])).toThrowError(
        ProblemDetailsError,
      );
    } finally {
      resetHandleSecret();
      installTestHandleSecret();
    }
  });

  it('every invalid permutation shares ONE bounded message — order-independent', () => {
    const permutations: Array<[Record<string, string>, Iterable<string>]> = [
      [{ 'airport-a': 'x' }, KEYS], // plain stable-only
      [{ 'airport-a': 'x', [HANDLE_B]: 'y' }, KEYS], // mixed, order 1
      [{ [HANDLE_B]: 'y', 'airport-a': 'x' }, KEYS], // mixed, order 2
      [{ s0: 'x' }, KEYS], // ordinal
      [{ s1: 'x' }, KEYS],
      [{ 'ref-0123456789abcdef': 'x' }, KEYS], // ref-like
      [{ '01234567-0123-4123-8123-0123456789ab': 'x' }, KEYS], // UUID-like
      [{ 'src-0000000000000000': 'x' }, KEYS], // invented src
    ];
    const messages = new Set<string>();
    for (const [aliases, keys] of permutations) {
      try {
        resolveSourceAliasKeys(aliases, keys);
        expect.unreachable(`permutation should have failed: ${JSON.stringify(aliases)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProblemDetailsError);
        const message = error instanceof Error ? error.message : String(error);
        messages.add(message);
        expect(message).toContain('src-');
      }
    }
    // EXACTLY one bounded error text across every permutation
    expect(messages.size).toBe(1);
  });
});
