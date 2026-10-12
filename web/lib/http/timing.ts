import { AsyncLocalStorage } from 'node:async_hooks';
interface Metrics {
  started: number;
  storageMs: number;
  storageCalls: number;
}
const timing = new AsyncLocalStorage<Metrics>();
export async function timeRequest(work: () => Promise<Response>): Promise<Response> {
  const metrics = { started: performance.now(), storageMs: 0, storageCalls: 0 };
  return timing.run(metrics, async () => {
    const response = await work();
    response.headers.set(
      'Server-Timing',
      `total;dur=${(performance.now() - metrics.started).toFixed(1)}, storage;dur=${metrics.storageMs.toFixed(1)};desc="Summed logical await time", storage_calls;desc="${metrics.storageCalls}"`,
    );
    return response;
  });
}
/** Instrument SDK promise-returning operations, including pipeline exec. No keys/values logged. */
export function instrumentRedis<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, prop) {
      const value = Reflect.get(object, prop, object);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'multi' || prop === 'pipeline')
          return instrumentRedis(value.apply(object, args));
        const started = performance.now();
        const result = value.apply(object, args);
        if (result && typeof result.then === 'function') {
          const metrics = timing.getStore();
          if (!metrics) return result;
          metrics.storageCalls++;
          return Promise.resolve(result).finally(() => {
            metrics.storageMs += performance.now() - started;
          });
        }
        // Fluent pipeline command methods return this.
        return result === object ? instrumentRedis(object) : result;
      };
    },
  });
}
