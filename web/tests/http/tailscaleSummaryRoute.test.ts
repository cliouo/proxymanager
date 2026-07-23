import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveScopeProfile: vi.fn(),
  summariseTailscale: vi.fn(),
  listProfileDevices: vi.fn(),
}));

vi.mock('@/lib/profileScope', () => ({ resolveScopeProfile: mocks.resolveScopeProfile }));
vi.mock('@/lib/scenarios/tailscale/scenario', () => ({
  summariseTailscale: mocks.summariseTailscale,
}));
vi.mock('@/lib/services/deviceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/deviceService')>()),
  listProfileDevices: mocks.listProfileDevices,
}));

import { GET } from '@/app/api/v1/scenarios/tailscale/route';

describe('Tailscale summary route', () => {
  it('returns only matrix fields and never exposes auth key or base patch values', async () => {
    mocks.resolveScopeProfile.mockResolvedValue({
      id: 'p-1',
      name: 'home',
      kind: 'normal',
    });
    mocks.summariseTailscale.mockResolvedValue({
      initialized: true,
      nodes: [],
      groups: [],
      rules: [],
      anchors: [],
    });
    mocks.listProfileDevices.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'server',
        base_patch: { secret: 'base-secret' },
        features: {
          tailscale: {
            hostname: 'server-ts',
            authKey: 'tskey-secret',
            acceptRoutes: true,
            udp: true,
            ephemeral: false,
            exitNodeAllowLanAccess: false,
            extraCidrs: [],
          },
        },
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/scenarios/tailscale'));
    const body = await response.json();
    expect(body.data.devices[0]).toMatchObject({
      name: 'server',
      basePatchCount: 1,
      features: { tailscale: { hostname: 'server-ts', hasAuthKey: true } },
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain('tskey-secret');
    expect(json).not.toContain('base-secret');
  });
});
