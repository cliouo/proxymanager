import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRawScope,
  buildNodeScope,
  buildOperatorScope,
  buildProfileScope,
  buildSourceAliasScope,
  buildTargetRefScope,
} from '@/lib/proxies/handleScopes';
import { HANDLE_COLLISION_ERROR } from '@/lib/proxies/handleIndex';
import { injectHandleSignerForTests, resetHandleSecret } from '@/lib/proxies/handles';
import { installTestHandleSecret } from '@/tests/helpers/handleSecret';

/**
 * Round-1 typed HandleScopes tests: each semantic factory builds ONE
 * collision-checked index over the COMPLETE authorized domain before any
 * projection/resolution; handles from unrelated purposes never collide or
 * cross-resolve; identical text under different purposes yields different
 * tokens (distinct MAC domain tags).
 */

beforeAll(() => {
  installTestHandleSecret();
});

afterEach(() => {
  resetHandleSecret();
  installTestHandleSecret();
});

const PID = '33333333-3333-4333-8333-333333333333';

describe('typed handle scopes', () => {
  it('target scope: project/resolve round-trip over the complete visible union', () => {
    const visible = [
      { type: 'subscription' as const, id: '11111111-1111-4111-8111-111111111111' },
      { type: 'collection' as const, id: '22222222-2222-4222-8222-222222222222' },
    ];
    const scope = buildTargetRefScope(PID, visible);
    expect(scope.size).toBe(2);
    const ref = scope.project('subscription:11111111-1111-4111-8111-111111111111');
    expect(ref).toMatch(/^ref-[0-9a-f]{16}$/);
    expect(scope.resolve(ref)).toBe('subscription:11111111-1111-4111-8111-111111111111');
    expect(scope.has(ref)).toBe(true);
    expect(
      scope.has(
        buildTargetRefScope(PID, [
          { type: 'collection', id: '22222222-2222-4222-8222-222222222222' },
        ]).project('collection:22222222-2222-4222-8222-222222222222'),
      ),
    ).toBe(true);
    expect(scope.resolve('ref-0000000000000000')).toBeNull();
  });

  it('target refs are profile-bound: another profile cannot resolve the same ref', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    const id = '11111111-1111-4111-8111-111111111111';
    const scopeA = buildTargetRefScope(PID, [{ type: 'subscription', id }]);
    const scopeB = buildTargetRefScope(other, [{ type: 'subscription', id }]);
    const refA = scopeA.project(`subscription:${id}`);
    expect(scopeB.resolve(refA)).toBeNull();
    expect(refA).not.toBe(scopeB.project(`subscription:${id}`));
  });

  it('distinct purposes: identical text under different MAC domain tags never collides', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    // a target ref and a profile ref over the SAME id text must differ
    const target = buildTargetRefScope(PID, [{ type: 'subscription', id }]).project(
      `subscription:${id}`,
    );
    const profile = buildProfileScope(PID, [id]).project(`profile:${id}`);
    expect(target).not.toBe(profile);
    // node/operator/source scopes over the same text also differ
    const node = buildNodeScope(PID, [`${id}`]).project(id);
    const op = buildOperatorScope([id]).project(id);
    const src = buildSourceAliasScope([id]).project(id);
    expect(new Set([target, profile, node, op, src]).size).toBe(5);
    // and cross-purpose resolution fails: the node handle is not in the
    // target scope, etc.
    const targetScope = buildTargetRefScope(PID, [{ type: 'subscription', id }]);
    expect(targetScope.resolve(node)).toBeNull();
    expect(targetScope.resolve(profile)).toBeNull();
  });

  it('source scope: complete key set indexed before projection; collisions fail closed', () => {
    const scope = buildSourceAliasScope(['airport-a', 'airport-b']);
    const handleA = scope.project('airport-a');
    expect(handleA).toMatch(/^src-[0-9a-f]{16}$/);
    expect(scope.resolve(handleA)).toBe('airport-a');
    expect(scope.project('airport-b')).not.toBe(handleA);
    // duplicates collapse to one identity
    const dup = buildSourceAliasScope(['x', 'x']);
    expect(dup.size).toBe(1);
  });

  it('operator scope: entire stored list (parked synthetic ids included) is the domain', () => {
    const ids = ['op-1', 'op-2', 'parked-3'];
    const scope = buildOperatorScope(ids);
    expect(scope.size).toBe(3);
    const h = scope.project('parked-3');
    expect(h).toMatch(/^op-[0-9a-f]{16}$/);
    expect(scope.resolve(h)).toBe('parked-3');
  });

  it('node scope: salt-bound snapshot; same identity text under different salts differs', () => {
    const scopeA = buildNodeScope('salt-a', ['node-1', 'node-2']);
    const scopeB = buildNodeScope('salt-b', ['node-1']);
    const h1 = scopeA.project('node-1');
    expect(h1).toMatch(/^nd-[0-9a-f]{16}$/);
    expect(scopeA.resolve(h1)).toBe('node-1');
    expect(scopeB.resolve(h1)).toBeNull();
    expect(scopeB.project('node-1')).not.toBe(h1);
  });

  it('profile scope: complete consuming-profile set in one response', () => {
    const consumers = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const scope = buildProfileScope(PID, consumers);
    expect(scope.size).toBe(2);
    const h = scope.project('profile:11111111-1111-4111-8111-111111111111');
    expect(h).toMatch(/^ref-[0-9a-f]{16}$/);
    expect(scope.resolve(h)).toBe('profile:11111111-1111-4111-8111-111111111111');
  });

  it('round-2: project verifies EXACT identity membership — an out-of-domain identity fails even when its handle collides', () => {
    const collisionSigner = { mac: () => 'same-mac-for-everything' };
    injectHandleSignerForTests(collisionSigner as never);
    try {
      // scope contains ONLY 'authorized'; 'outside' hashes to the SAME token
      const scope = buildSourceAliasScope(['authorized']);
      expect(scope.project('authorized')).toBe('src-same-mac-for-everything');
      expect(() => scope.project('outside')).toThrowError(HANDLE_COLLISION_ERROR);
      // resolve stays exact: the out-of-domain identity never resolves
      expect(scope.resolve('src-same-mac-for-everything')).toBe('authorized');
      expect(scope.has('src-same-mac-for-everything')).toBe(true);
    } finally {
      injectHandleSignerForTests(null);
    }
  });

  it('round-2: operator scope rejects duplicate IDs in one pipeline; other scopes dedupe repeated identities', () => {
    // an ID-only handle cannot identify two rows — duplicate ids in ONE
    // pipeline are ambiguous and fail bounded
    expect(() => buildOperatorScope(['op-1', 'op-1'])).toThrowError(HANDLE_COLLISION_ERROR);
    // parked synthetic positional ids stay addressable
    const scope = buildOperatorScope(['parked-0', 'op-1', 'parked-2']);
    expect(scope.size).toBe(3);
    expect(scope.project('parked-2')).toMatch(/^op-[0-9a-f]{16}$/);
    // repeated occurrences of the SAME semantic identity in other scopes
    // dedupe (one identity, one handle)
    const src = buildSourceAliasScope(['a', 'a', 'b']);
    expect(src.size).toBe(2);
    expect(src.project('a')).toBe(src.project('a'));
  });

  it('round-2: force the SECOND identity beyond a cap to collide — construction fails before any output/cap', () => {
    const collisionSigner = { mac: () => 'same-mac-for-everything' };
    injectHandleSignerForTests(collisionSigner as never);
    try {
      // 200 identities: a collision between identity #1 and #199 must fail
      // the COMPLETE-domain construction, not a capped subset
      const many = Array.from({ length: 200 }, (_, i) => `id-${i}`);
      expect(() => buildSourceAliasScope(many)).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() => buildOperatorScope(many)).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() => buildNodeScope('salt', many)).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() =>
        buildTargetRefScope(
          'profile',
          many.map((id) => ({ type: 'subscription' as const, id })),
        ),
      ).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() => buildProfileScope('caller', many)).toThrowError(HANDLE_COLLISION_ERROR);
    } finally {
      injectHandleSignerForTests(null);
    }
  });

  it('a forced MAC collision anywhere in the domain fails the scope build (never after a cap)', () => {
    const collisionSigner = {
      mac: () => 'same-mac-for-everything',
    };
    injectHandleSignerForTests(collisionSigner as never);
    try {
      expect(() => buildSourceAliasScope(['a', 'b'])).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() =>
        buildTargetRefScope(PID, [
          { type: 'subscription', id: '11111111-1111-4111-8111-111111111111' },
          { type: 'collection', id: '22222222-2222-4222-8222-222222222222' },
        ]),
      ).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() => buildOperatorScope(['a', 'b'])).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() => buildNodeScope('s', ['a', 'b'])).toThrowError(HANDLE_COLLISION_ERROR);
      expect(() => buildProfileScope(PID, ['a', 'b'])).toThrowError(HANDLE_COLLISION_ERROR);
    } finally {
      injectHandleSignerForTests(null);
    }
  });

  it('identical operator ids across different targets and identical text across purposes do not falsely collide', () => {
    // two scopes over the same id — each builds its own index fine
    const a = buildOperatorScope(['op-x']);
    const b = buildOperatorScope(['op-x']);
    expect(a.project('op-x')).toBe(b.project('op-x'));
    // identical TEXT in different purpose scopes yields different handles
    const node = buildNodeScope('', ['same-text']).project('same-text');
    const source = buildSourceAliasScope(['same-text']).project('same-text');
    expect(node).not.toBe(source);
  });

  it.each(['skipEmpty', 'rejectDuplicates'] as const)(
    'ignores inherited Object.prototype.%s option getters',
    (key) => {
      let fired = 0;
      let scope: ReturnType<typeof buildRawScope> | undefined;
      const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          fired += 1;
          throw new Error(`prototype ${key} getter should stay unobserved`);
        },
      });
      try {
        scope = buildRawScope('source', ['', 'a', 'a']);
      } finally {
        if (prior === undefined) {
          Reflect.deleteProperty(Object.prototype, key);
        } else {
          Object.defineProperty(Object.prototype, key, prior);
        }
      }

      expect(fired).toBe(0);
      expect(scope?.size).toBe(1);
      const built = scope!;
      expect(built.resolve(built.project('a'))).toBe('a');
    },
  );
});

const readFs = await import('node:fs');
const readPath = await import('node:path');

describe('round-3 forbidden single-mint capability scan', () => {
  it('no production module defines, imports or calls a semantic single-mint constructor', () => {
    const { readFileSync, readdirSync, statSync } = readFs;
    const { join } = readPath;
    // semantic single-mint CALLS/definitions/imports (an object KEY named
    // `operatorHandle:` is the write-result wire contract, not a mint call)
    const CALL =
      /\b(?:targetRefHandle|profileRefHandle|operatorRefHandle|sourceRefHandle|nodeRefHandle|namingTargetRefOf|handleOf|operatorHandle)\s*\(/g;
    // prefixed token constructors must not exist at all outside the primitives
    const BARE = /\b(?:HANDLE_DOMAINS|domainHandle)\b/g;
    const roots = [join(process.cwd(), 'lib'), join(process.cwd(), 'app')];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    // the scope/handle primitives themselves are the implementation home
    const implementation = new Set([
      join(process.cwd(), 'lib/proxies/handleScopes.ts'),
      join(process.cwd(), 'lib/proxies/handles.ts'),
      join(process.cwd(), 'lib/proxies/handleIndex.ts'),
    ]);
    for (const file of files) {
      if (implementation.has(file)) continue;
      const content = readFileSync(file, 'utf8');
      expect(content.match(CALL), file).toBeNull();
      expect(content.match(BARE), file).toBeNull();
    }
  });
});
