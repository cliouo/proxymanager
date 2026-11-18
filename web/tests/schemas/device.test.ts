import { describe, expect, it } from 'vitest';
import {
  DeviceFeaturesSchema,
  DeviceSchema,
  MAX_TAILSCALE_INSTANCES_PER_DEVICE,
  TailscaleDeviceFeatureUpdateSchema,
  TailscaleInstanceCreateSchema,
  publicDeviceFeatures,
  tailscaleServiceRouteKey,
} from '@/schemas';

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

  it('keeps a legacy single-instance device readable without new fields', () => {
    const parsed = DeviceSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'server',
      base_patch: {},
      features: { tailscale: { hostname: 'server-ts' } },
      created_at: 1,
      updated_at: 1,
    });
    expect(parsed.features.tailscale).toMatchObject({ hostname: 'server-ts', extraCidrs: [] });
    expect(parsed.features.tailscale?.routeMode).toBeUndefined();
    expect(parsed.features.tailscaleInstances).toBeUndefined();
  });

  it('accepts extra instances that carry an id and explicit service routes', () => {
    const parsed = DeviceFeaturesSchema.parse({
      tailscale: { hostname: 'legacy-ts' },
      tailscaleInstances: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          hostname: 'extra-a',
          routeMode: 'service',
          serviceRoutes: [
            { ip: '100.100.1.2', port: 443 },
            { ip: 'fd7a:115c:a1e0::1', port: 8443 },
          ],
        },
      ],
    });
    expect(parsed.tailscaleInstances?.[0]).toMatchObject({
      hostname: 'extra-a',
      routeMode: 'service',
      extraCidrs: [],
    });
    expect(parsed.tailscaleInstances?.[0]?.serviceRoutes).toHaveLength(2);
  });

  it('rejects an extra instance without routes, without an id, or in CIDR mode', () => {
    expect(() =>
      DeviceFeaturesSchema.parse({
        tailscaleInstances: [{ id: '22222222-2222-4222-8222-222222222222', hostname: 'extra-a' }],
      }),
    ).toThrow(/服务模式/);

    expect(() =>
      DeviceFeaturesSchema.parse({
        tailscaleInstances: [
          {
            hostname: 'extra-a',
            routeMode: 'service',
            serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
          },
        ],
      }),
    ).toThrow(/稳定 id/);

    expect(() =>
      DeviceFeaturesSchema.parse({
        tailscaleInstances: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            hostname: 'extra-a',
            serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
          },
        ],
      }),
    ).toThrow(/服务模式|不能同时携带/);
  });

  it('rejects service mode combined with extra CIDRs, and an empty service list', () => {
    expect(() =>
      DeviceFeaturesSchema.parse({
        tailscale: {
          hostname: 'server',
          routeMode: 'service',
          serviceRoutes: [],
        },
      }),
    ).toThrow(/至少/);

    expect(() =>
      DeviceFeaturesSchema.parse({
        tailscale: {
          hostname: 'server',
          routeMode: 'service',
          serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
          extraCidrs: ['10.23.0.0/16'],
        },
      }),
    ).toThrow(/互斥/);
  });

  it('rejects duplicate service routes inside one instance using canonical IP spellings', () => {
    expect(() =>
      DeviceFeaturesSchema.parse({
        tailscale: {
          hostname: 'server',
          routeMode: 'service',
          serviceRoutes: [
            { ip: '2001:DB8::1', port: 443 },
            { ip: '2001:db8:0:0:0:0:0:1', port: 443 },
          ],
        },
      }),
    ).toThrow(/不能重复/);
  });

  it('validates port bounds and address family in service routes', () => {
    for (const port of [-1, 65_536, 1.5]) {
      expect(() =>
        TailscaleDeviceFeatureUpdateSchema.parse({
          hostname: 'server',
          serviceRoutes: [{ ip: '100.100.1.2', port }],
        }),
      ).toThrow();
    }
    expect(() =>
      TailscaleDeviceFeatureUpdateSchema.parse({
        hostname: 'server',
        serviceRoutes: [{ ip: 'not-an-ip', port: 443 }],
      }),
    ).toThrow(/IPv4 或 IPv6/);
    expect(
      TailscaleDeviceFeatureUpdateSchema.parse({
        hostname: 'server',
        serviceRoutes: [{ ip: '2001:db8::1', port: 0 }],
      }).serviceRoutes,
    ).toEqual([{ ip: '2001:db8::1', port: 0 }]);
  });

  it('canonicalises equivalent spellings to one comparison key', () => {
    expect(tailscaleServiceRouteKey({ ip: '2001:DB8::1', port: 443 })).toBe(
      tailscaleServiceRouteKey({ ip: '2001:db8:0:0:0:0:0:1', port: 443 }),
    );
    expect(tailscaleServiceRouteKey({ ip: '100.100.1.2', port: 443 })).not.toBe(
      tailscaleServiceRouteKey({ ip: '100.100.1.2', port: 8443 }),
    );
  });

  it('caps the total instance count per device', () => {
    const instance = (index: number) => ({
      id: `2222222${index % 10}-2222-4222-8222-22222222222${index % 10}`,
      hostname: `extra-${index}`,
      routeMode: 'service' as const,
      serviceRoutes: [{ ip: '100.100.1.2', port: 1000 + index }],
    });
    const tooMany = Array.from({ length: MAX_TAILSCALE_INSTANCES_PER_DEVICE }, (_, i) =>
      instance(i),
    );
    expect(() =>
      DeviceFeaturesSchema.parse({
        tailscale: { hostname: 'legacy' },
        tailscaleInstances: tooMany,
      }),
    ).toThrow(/最多/);
  });

  it('redacts every instance auth key at the public boundary', () => {
    const safe = publicDeviceFeatures({
      tailscale: {
        hostname: 'legacy',
        authKey: 'tskey-legacy-secret',
        acceptRoutes: true,
        udp: true,
        ephemeral: false,
        exitNodeAllowLanAccess: false,
        extraCidrs: [],
      },
      tailscaleInstances: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          hostname: 'extra',
          authKey: 'tskey-extra-secret',
          routeMode: 'service',
          serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
          acceptRoutes: true,
          udp: true,
          ephemeral: false,
          exitNodeAllowLanAccess: false,
          extraCidrs: [],
        },
      ],
    });
    expect(safe.tailscale?.hasAuthKey).toBe(true);
    expect(safe.tailscaleInstances?.[0]?.hasAuthKey).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('tskey-legacy-secret');
    expect(JSON.stringify(safe)).not.toContain('tskey-extra-secret');
  });

  it('requires at least one route for additional instances at the write schema', () => {
    expect(() =>
      TailscaleInstanceCreateSchema.parse({
        hostname: 'extra',
        routeMode: 'service',
        serviceRoutes: [],
      }),
    ).toThrow();
  });
});
