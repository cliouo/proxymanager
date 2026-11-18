/**
 * `/api/v1/profiles/[id]/devices/[deviceId]/features/tailscale/instances`
 * and `.../instances/[instanceId]`.
 *
 * The routes are thin: they only parse the payload and delegate to
 * `deviceService`, which owns the version-bracketed preflight + CAS + audit
 * pipeline. These tests pin two contracts that the service layer cannot state
 * on its own: the legacy single-instance URL is untouched by instance calls,
 * and no auth key ever appears in an instance response.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listDeviceTailscaleInstances: vi.fn(),
  createDeviceTailscaleInstance: vi.fn(),
  putDeviceTailscaleInstance: vi.fn(),
  deleteDeviceTailscaleInstance: vi.fn(),
  getDeviceTailscaleFeature: vi.fn(),
  putDeviceTailscaleFeature: vi.fn(),
  deleteDeviceTailscaleFeature: vi.fn(),
}));

vi.mock('@/lib/services/deviceService', () => ({
  listDeviceTailscaleInstances: mocks.listDeviceTailscaleInstances,
  createDeviceTailscaleInstance: mocks.createDeviceTailscaleInstance,
  putDeviceTailscaleInstance: mocks.putDeviceTailscaleInstance,
  deleteDeviceTailscaleInstance: mocks.deleteDeviceTailscaleInstance,
  getDeviceTailscaleFeature: mocks.getDeviceTailscaleFeature,
  putDeviceTailscaleFeature: mocks.putDeviceTailscaleFeature,
  deleteDeviceTailscaleFeature: mocks.deleteDeviceTailscaleFeature,
}));

import { GET as legacyGet } from '@/app/api/v1/profiles/[id]/devices/[deviceId]/features/tailscale/route';
import {
  DELETE as instanceDelete,
  PUT as instancePut,
} from '@/app/api/v1/profiles/[id]/devices/[deviceId]/features/tailscale/instances/[instanceId]/route';
import {
  GET as instancesGet,
  POST as instancesPost,
} from '@/app/api/v1/profiles/[id]/devices/[deviceId]/features/tailscale/instances/route';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';

function ctx(instanceId?: string) {
  return {
    params: Promise.resolve(
      instanceId
        ? { id: PROFILE_ID, deviceId: DEVICE_ID, instanceId }
        : { id: PROFILE_ID, deviceId: DEVICE_ID },
    ),
  } as never;
}

function instance(over: Record<string, unknown> = {}) {
  return {
    id: INSTANCE_ID,
    hostname: 'synthetic-extra',
    routeMode: 'service',
    serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
    ephemeral: false,
    acceptRoutes: true,
    udp: true,
    exitNodeAllowLanAccess: false,
    extraCidrs: [],
    hasAuthKey: true,
    ...over,
  };
}

describe('device Tailscale instance routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists additional instances and any advisories', async () => {
    mocks.listDeviceTailscaleInstances.mockResolvedValue({
      instances: [instance()],
      warnings: ['synthetic warning'],
    });

    const res = await instancesGet(new Request('https://pm.test'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [instance()],
      warnings: ['synthetic warning'],
    });
    expect(mocks.listDeviceTailscaleInstances).toHaveBeenCalledWith(PROFILE_ID, DEVICE_ID);
  });

  it('creates an instance from a JSON body and points Location at its id', async () => {
    mocks.createDeviceTailscaleInstance.mockResolvedValue({
      instance: instance(),
      warnings: [],
    });

    const res = await instancesPost(
      new Request('https://pm.test', {
        method: 'POST',
        body: JSON.stringify({
          hostname: 'synthetic-extra',
          serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
        }),
      }),
      ctx(),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toBe(
      `/api/v1/profiles/${PROFILE_ID}/devices/${DEVICE_ID}/features/tailscale/instances/${INSTANCE_ID}`,
    );
    expect(mocks.createDeviceTailscaleInstance).toHaveBeenCalledWith(PROFILE_ID, DEVICE_ID, {
      hostname: 'synthetic-extra',
      serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
      ephemeral: false,
      acceptRoutes: true,
      udp: true,
      exitNodeAllowLanAccess: false,
    });
  });

  it('rejects a create without a service route before calling the service', async () => {
    const res = await instancesPost(
      new Request('https://pm.test', {
        method: 'POST',
        body: JSON.stringify({ hostname: 'synthetic-extra' }),
      }),
      ctx(),
    );
    expect(res.status).toBe(422);
    expect(mocks.createDeviceTailscaleInstance).not.toHaveBeenCalled();
  });

  it('rejects extra CIDRs on an additional instance', async () => {
    const res = await instancesPost(
      new Request('https://pm.test', {
        method: 'POST',
        body: JSON.stringify({
          hostname: 'synthetic-extra',
          serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
          extraCidrs: ['10.23.0.0/16'],
        }),
      }),
      ctx(),
    );
    expect(res.status).toBe(422);
    expect(mocks.createDeviceTailscaleInstance).not.toHaveBeenCalled();
  });

  it('updates exactly the addressed instance', async () => {
    mocks.putDeviceTailscaleInstance.mockResolvedValue({
      instance: instance({ hostname: 'renamed' }),
      warnings: [],
    });

    const res = await instancePut(
      new Request('https://pm.test', {
        method: 'PUT',
        body: JSON.stringify({ hostname: 'renamed' }),
      }),
      ctx(INSTANCE_ID),
    );

    expect(res.status).toBe(200);
    expect(mocks.putDeviceTailscaleInstance).toHaveBeenCalledWith(
      PROFILE_ID,
      DEVICE_ID,
      INSTANCE_ID,
      { hostname: 'renamed' },
    );
  });

  it('404s a delete of an unknown instance', async () => {
    mocks.deleteDeviceTailscaleInstance.mockResolvedValue({ deleted: false, warnings: [] });
    const res = await instanceDelete(new Request('https://pm.test'), ctx(INSTANCE_ID));
    expect(res.status).toBe(404);
  });

  it('keeps the legacy feature URL scoped to the original slot', async () => {
    mocks.getDeviceTailscaleFeature.mockResolvedValue({ feature: null, warnings: [] });
    await legacyGet(new Request('https://pm.test'), ctx());
    expect(mocks.getDeviceTailscaleFeature).toHaveBeenCalledWith(PROFILE_ID, DEVICE_ID);
    expect(mocks.listDeviceTailscaleInstances).not.toHaveBeenCalled();
  });

  it('never echoes an auth key from an instance response', async () => {
    mocks.createDeviceTailscaleInstance.mockResolvedValue({
      instance: instance(),
      warnings: [],
    });
    const res = await instancesPost(
      new Request('https://pm.test', {
        method: 'POST',
        body: JSON.stringify({
          hostname: 'synthetic-extra',
          authKey: 'tskey-never-return',
          serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
        }),
      }),
      ctx(),
    );
    const body = await res.text();
    expect(body).not.toContain('tskey-never-return');
    expect(body).toContain('hasAuthKey');
  });
});
