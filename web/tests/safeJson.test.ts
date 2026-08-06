import { describe, expect, it } from 'vitest';
import { attachRawOperators, RAW_OPERATORS, restoreRawOperators } from '@/lib/repos/rawOperators';
import { safeJsonClone, safeJsonStringify, UNSAFE_JSON_VALUE_ERROR } from '@/lib/security/safeJson';

function withPrototypeProperty<T>(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  run: () => T,
): T {
  const prior = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  try {
    return run();
  } finally {
    if (prior === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, prior);
  }
}

describe('safe JSON persistence boundary', () => {
  it.each([Object.prototype, Array.prototype])(
    'ignores inherited toJSON data hooks on %s',
    (prototype) => {
      let fired = 0;
      const serialized = withPrototypeProperty(
        prototype,
        'toJSON',
        {
          value() {
            fired += 1;
            return { hijacked: true };
          },
          writable: true,
        },
        () => safeJsonStringify({ operators: [{ id: 'x', enabled: true }] }),
      );
      expect(fired).toBe(0);
      expect(JSON.parse(serialized)).toEqual({ operators: [{ id: 'x', enabled: true }] });
    },
  );

  it.each([Object.prototype, Array.prototype])(
    'ignores inherited toJSON getters on %s',
    (prototype) => {
      let fired = 0;
      const serialized = withPrototypeProperty(
        prototype,
        'toJSON',
        {
          get() {
            fired += 1;
            throw new Error('prototype getter should stay unobserved');
          },
        },
        () => safeJsonStringify({ operators: [{ id: 'x' }] }),
      );
      expect(fired).toBe(0);
      expect(JSON.parse(serialized)).toEqual({ operators: [{ id: 'x' }] });
    },
  );

  it('rejects accessors, proxies, symbols and cycles before serialization', () => {
    let getterFired = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get() {
        getterFired += 1;
        return 'no';
      },
    });
    expect(() => safeJsonStringify(accessor)).toThrow(UNSAFE_JSON_VALUE_ERROR);
    expect(getterFired).toBe(0);
    expect(() => safeJsonStringify(new Proxy({ ok: true }, {}))).toThrow(UNSAFE_JSON_VALUE_ERROR);
    expect(() => safeJsonStringify({ [Symbol('x')]: true })).toThrow(UNSAFE_JSON_VALUE_ERROR);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => safeJsonStringify(cycle)).toThrow(UNSAFE_JSON_VALUE_ERROR);
  });

  it('is idempotent for already-hardened arrays', () => {
    const hardened = safeJsonClone({ operators: [{ id: 'x', enabled: true }] });
    expect(JSON.parse(safeJsonStringify(hardened))).toEqual({
      operators: [{ id: 'x', enabled: true }],
    });
  });

  it('does not let prototype hooks restore an explicitly edited operator list', () => {
    const raw = [{ id: 'f', kind: 'filter-regex', mode: 'keep', pattern: 'HK' }];
    const edited = [{ id: 'f', kind: 'filter-regex', mode: 'drop', pattern: 'JP' }];
    const attached = attachRawOperators({ operators: raw }, raw);
    let fired = 0;
    const restored = withPrototypeProperty(
      Object.prototype,
      'toJSON',
      {
        get() {
          fired += 1;
          return () => raw;
        },
      },
      () => restoreRawOperators({ ...attached, operators: edited }),
    );

    expect(fired).toBe(0);
    expect(restored.operators).toEqual(edited);
    expect(Object.getOwnPropertySymbols(restored)).not.toContain(RAW_OPERATORS);
    expect(safeJsonClone(restored).operators).toEqual(edited);
  });
});
