/**
 * Shared test DI for the keyed handle service: pin a STABLE EXPLICIT key so
 * every handle computed anywhere in the suite is deterministic and
 * round-trip-safe, without reading any real environment secret. Matches the
 * repo's secret-injection boundary (lib/proxies/handles.ts).
 */

import { injectHandleSecret } from '@/lib/proxies/handles';

/** Fixed test-only key — never a real secret. */
export const TEST_HANDLE_SECRET = 'test-only-handle-secret-0000000000000000';

/** Pin the test key for the whole process (idempotent). */
export function installTestHandleSecret(): void {
  injectHandleSecret(TEST_HANDLE_SECRET);
}
