import { describe, expect, it } from 'vitest';
import { DeviceSchema, TailscaleDeviceFeatureUpdateSchema, publicDeviceFeatures } from '@/schemas';

describe('DeviceSchema features', () => {
  it('parse-forwards persisted P1 devices that have no features field', () => {
    const parsed = DeviceSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'macbook',
      base_patch: {},
      created_at: 1,
      updated_at: 1,
    });
    expect(parsed.features).toEqual({});
  });

  it('fills stable defaults for a typed Tailscale instance', () => {
    const parsed = DeviceSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'server',
      base_patch: {},
      features: { tailscale: { hostname: 'server-ts' } },
      created_at: 1,
      updated_at: 1,
    });
    expect(parsed.features.tailscale).toMatchObject({
      hostname: 'server-ts',
      acceptRoutes: true,
      udp: true,
      ephemeral: false,
      exitNodeAllowLanAccess: false,
      extraCidrs: [],
    });
  });

  it('converts auth key to a presence flag at the public boundary', () => {
    const safe = publicDeviceFeatures({
      tailscale: {
        hostname: 'server-ts',
        authKey: 'tskey-never-return',
        acceptRoutes: true,
        udp: true,
        ephemeral: false,
        exitNodeAllowLanAccess: false,
        extraCidrs: [],
      },
    });
    expect(safe.tailscale).toMatchObject({ hostname: 'server-ts', hasAuthKey: true });
    expect(JSON.stringify(safe)).not.toContain('tskey-never-return');
  });

  it('uses null only as the explicit clear-auth-key command', () => {
    expect(
      TailscaleDeviceFeatureUpdateSchema.parse({ hostname: 'server', authKey: null }).authKey,
    ).toBeNull();
  });

  it('rejects credentials hidden inside a public control URL', () => {
    expect(() =>
      TailscaleDeviceFeatureUpdateSchema.parse({
        hostname: 'server',
        controlUrl: 'https://admin:secret@headscale.example.com',
      }),
    ).toThrow(/账号/);
  });

  it('rejects malformed extra CIDRs before render-time preflight', () => {
    expect(() =>
      TailscaleDeviceFeatureUpdateSchema.parse({
        hostname: 'server',
        extraCidrs: ['not-a-cidr'],
      }),
    ).toThrow(/CIDR/);
  });

  it('rejects duplicate extra CIDRs instead of reporting a false route count', () => {
    expect(() =>
      TailscaleDeviceFeatureUpdateSchema.parse({
        hostname: 'server',
        extraCidrs: ['10.0.0.0/8', '10.0.0.0/8'],
      }),
    ).toThrow(/不能重复/);
  });
});
