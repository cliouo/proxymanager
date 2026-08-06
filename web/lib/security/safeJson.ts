import { types } from 'node:util';

/** Fixed internal error: persistence inputs must be inert JSON data. */
export const UNSAFE_JSON_VALUE_ERROR = '待持久化数据不是安全的 JSON 数据。';

const OMIT = Symbol('safe-json-omit');

function nullDescriptor(value: unknown, enumerable = true): PropertyDescriptor {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = enumerable;
  descriptor.configurable = true;
  return descriptor;
}

function dataValue(descriptor: PropertyDescriptor): unknown {
  if (Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) {
    throw new Error(UNSAFE_JSON_VALUE_ERROR);
  }
  if (!Object.hasOwn(descriptor, 'value')) throw new Error(UNSAFE_JSON_VALUE_ERROR);
  return descriptor.value;
}

function cloneJsonData(value: unknown, stack: WeakSet<object>, arraySlot: boolean): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined) return arraySlot ? null : OMIT;
  if (typeof value !== 'object') throw new Error(UNSAFE_JSON_VALUE_ERROR);
  if (types.isProxy(value)) throw new Error(UNSAFE_JSON_VALUE_ERROR);
  if (stack.has(value)) throw new Error(UNSAFE_JSON_VALUE_ERROR);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(UNSAFE_JSON_VALUE_ERROR);
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error(UNSAFE_JSON_VALUE_ERROR);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor ? dataValue(lengthDescriptor) : undefined;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        throw new Error(UNSAFE_JSON_VALUE_ERROR);
      }
      const out: unknown[] = [];
      // Shadow inherited Array/Object prototype hooks before serialization.
      Object.defineProperty(out, 'toJSON', nullDescriptor(undefined, false));
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) throw new Error(UNSAFE_JSON_VALUE_ERROR);
        if (
          key === 'toJSON' &&
          descriptor.enumerable === false &&
          Object.hasOwn(descriptor, 'value') &&
          descriptor.value === undefined
        ) {
          // Idempotency marker added to hardened arrays above. No other
          // own toJSON shape is accepted, and accessors are never observed.
          continue;
        }
        dataValue(descriptor); // reject accessors even when non-enumerable
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (length as number)) {
          throw new Error(UNSAFE_JSON_VALUE_ERROR);
        }
      }
      for (let i = 0; i < (length as number); i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        const cloned = descriptor ? cloneJsonData(dataValue(descriptor), stack, true) : null; // JSON array holes serialize as null.
        Object.defineProperty(out, String(i), nullDescriptor(cloned));
      }
      return out;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(UNSAFE_JSON_VALUE_ERROR);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(UNSAFE_JSON_VALUE_ERROR);
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) throw new Error(UNSAFE_JSON_VALUE_ERROR);
      if (descriptor.enumerable !== true) throw new Error(UNSAFE_JSON_VALUE_ERROR);
      const cloned = cloneJsonData(dataValue(descriptor), stack, false);
      if (cloned !== OMIT) Object.defineProperty(out, key, nullDescriptor(cloned));
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

/** Clone inert JSON data without observing inherited hooks or accessors. */
export function safeJsonClone<T>(value: T): T {
  const cloned = cloneJsonData(value, new WeakSet(), false);
  if (cloned === OMIT) throw new Error(UNSAFE_JSON_VALUE_ERROR);
  return cloned as T;
}

/** Deterministic JSON serialization over the hardened clone. */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(safeJsonClone(value));
}
