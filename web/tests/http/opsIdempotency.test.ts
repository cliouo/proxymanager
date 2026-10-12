import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@/lib/scenarios/_shared/dispatch', () => mocks);
vi.mock('@/lib/profileScope', () => ({ resolveScopeProfile: async () => ({ id: 'profile-a' }) }));
import { POST } from '@/app/api/v1/ops/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue({ data: null, events: [] });
});
it('binds replay identity to the scenario and operation as well as payload and scope', async () => {
  const fingerprints: string[] = [];
  for (const [scenario, op] of [
    ['first', 'create'],
    ['first', 'delete'],
    ['second', 'create'],
    ['first', 'create'],
  ]) {
    const response = await POST(
      new Request('https://pm.test/api/v1/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-key-0001' },
        body: JSON.stringify({ scenario, op, payload: { id: 'same-target' } }),
      }),
    );
    expect(response.status).toBe(200);
    fingerprints.push(mocks.dispatch.mock.lastCall![0].operationIdentity.fingerprint);
  }
  expect(new Set(fingerprints.slice(0, 3)).size).toBe(3);
  expect(fingerprints[3]).toBe(fingerprints[0]);
});
