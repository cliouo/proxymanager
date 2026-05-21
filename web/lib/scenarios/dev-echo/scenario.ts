/**
 * `dev-echo` — a no-op scenario used to verify the dispatcher pipeline
 * end-to-end without mutating any real state.
 *
 * Two ops:
 *   - ping: returns the payload verbatim, no audit
 *   - mark: returns the payload and emits a single audit event with
 *     target {kind:'base'} so the /history page can be sanity-checked
 *     against scenario events
 *
 * Safe to keep in production; auth still applies, audit cap (1000) still
 * applies, and it can't corrupt config because it never touches the
 * BaseStore.
 */

import type { Scenario } from '../_shared/types';

export const echoScenario: Scenario = {
  descriptor: {
    id: 'dev-echo',
    title: 'Echo (dev)',
    description: 'No-op scenario for verifying the dispatcher pipeline.',
    navHref: '/scenarios/dev-echo',
  },
  ops: {
    async ping(_ctx, payload) {
      return { data: { echoed: payload }, events: [] };
    },
    async mark(_ctx, payload) {
      return {
        data: { echoed: payload },
        events: [
          {
            action: 'mark',
            target: { kind: 'base', field: 'dev-echo' },
            after: payload,
          },
        ],
      };
    },
  },
};
