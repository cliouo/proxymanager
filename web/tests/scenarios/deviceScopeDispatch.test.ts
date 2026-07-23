import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/scenarios/registry', () => ({
  getScenario: () => ({
    descriptor: { id: 'tailscale', title: 'Tailscale', scope: 'device' },
    ops: { enable: vi.fn() },
  }),
}));

import { dispatch } from '@/lib/scenarios/_shared/dispatch';

describe('scenario dispatcher device scope guard', () => {
  it('rejects device features before constructing a profile-scoped write context', async () => {
    await expect(
      dispatch({
        scenario: 'tailscale',
        op: 'enable',
        payload: { hostname: 'wrong-layer' },
        actor: 'test',
        profileId: 'p-1',
      }),
    ).rejects.toMatchObject({
      problem: { status: 422 },
    });
  });
});
