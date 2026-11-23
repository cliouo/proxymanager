import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigValidationError } from '@/lib/config/errors';
import type { Device } from '@/schemas';

const DEVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET_VALUE = 'real-secret-value';
const AUTH_KEY = 'tskey-auth-super-secret-123';

const mocks = vi.hoisted(() => ({
  device: null as Device | null,
  listProfileDevices: vi.fn(),
  getProfileDevice: vi.fn(),
  createDevice: vi.fn(),
  patchDevice: vi.fn(),
  deleteDevice: vi.fn(),
  putDeviceTailscaleFeature: vi.fn(),
  deleteDeviceTailscaleFeature: vi.fn(),
  listDeviceTailscaleInstances: vi.fn(),
  createDeviceTailscaleInstance: vi.fn(),
  putDeviceTailscaleInstance: vi.fn(),
  deleteDeviceTailscaleInstance: vi.fn(),
  buildDeviceConfig: vi.fn(),
  renderProfileConfig: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock('@/lib/services/deviceService', async () => {
  const { publicDeviceFeatures } = await import('@/schemas');
  return {
    listProfileDevices: mocks.listProfileDevices,
    getProfileDevice: mocks.getProfileDevice,
    createDevice: mocks.createDevice,
    patchDevice: mocks.patchDevice,
    deleteDevice: mocks.deleteDevice,
    putDeviceTailscaleFeature: mocks.putDeviceTailscaleFeature,
    deleteDeviceTailscaleFeature: mocks.deleteDeviceTailscaleFeature,
    listDeviceTailscaleInstances: mocks.listDeviceTailscaleInstances,
    createDeviceTailscaleInstance: mocks.createDeviceTailscaleInstance,
    putDeviceTailscaleInstance: mocks.putDeviceTailscaleInstance,
    deleteDeviceTailscaleInstance: mocks.deleteDeviceTailscaleInstance,
    publicDevice: (device: Device) => ({
      ...device,
      features: publicDeviceFeatures(device.features ?? {}),
    }),
  };
});
vi.mock('@/lib/engine/devicePatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/devicePatch')>();
  return { ...actual, buildDeviceConfig: mocks.buildDeviceConfig };
});
vi.mock('@/lib/engine/renderCache', () => ({ renderProfileConfig: mocks.renderProfileConfig }));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: mocks.getProfile }));

const CTX = { actor: 'test', profileId: 'profile-test' };

interface TestWriteAction {
  summary(input: Record<string, unknown>): string;
  preview(
    ctx: typeof CTX,
    input: Record<string, unknown>,
  ): Promise<{ diff: Record<string, unknown> }>;
  execute(ctx: typeof CTX, input: Record<string, unknown>): Promise<unknown>;
}

function requireWriteAction(
  actions: ReadonlyArray<{ name: string }>,
  name: string,
): TestWriteAction {
  const action = actions.find((item) => item.name === name);
  if (!action) throw new Error(`missing ${name}`);
  return action as unknown as TestWriteAction;
}

interface TestReadAction {
  run(ctx: typeof CTX, input: Record<string, unknown>): Promise<{ kind: string; data: unknown }>;
}

function requireReadAction(actions: ReadonlyArray<{ name: string }>, name: string): TestReadAction {
  const action = actions.find((item) => item.name === name);
  if (!action) throw new Error(`missing ${name}`);
  return action as unknown as TestReadAction;
}

function fixtureDevice(): Device {
  return {
    id: DEVICE_ID,
    name: 'macbook',
    display_name: 'MacBook Pro',
    base_patch: { secret: SECRET_VALUE, 'external-controller': '127.0.0.1:9090' },
    features: {
      tailscale: {
        hostname: 'mbp',
        authKey: AUTH_KEY,
        ephemeral: false,
        acceptRoutes: true,
        udp: true,
        exitNodeAllowLanAccess: false,
        extraCidrs: [],
      },
    },
    created_at: 1,
    updated_at: 1,
  };
}

beforeEach(() => {
  mocks.device = fixtureDevice();
  for (const fn of Object.values(mocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  }
  mocks.listProfileDevices.mockImplementation(async () => (mocks.device ? [mocks.device] : []));
  mocks.getProfileDevice.mockImplementation(async () => mocks.device);
  mocks.getProfile.mockResolvedValue({ id: 'profile-test', name: 'profile-test' });
  mocks.renderProfileConfig.mockResolvedValue({ resolved: { content: 'port: 7890\n' } });
});

describe('device assistant redaction', () => {
  it('list_devices masks patch secrets and never exposes the Tailscale auth key', async () => {
    const { DEVICE_READ_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireReadAction(DEVICE_READ_ACTIONS, 'list_devices');

    const result = await action.run(CTX, {});
    const serialized = JSON.stringify(result.data);
    expect(serialized).toContain('***');
    expect(serialized).toContain('hasAuthKey');
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain(AUTH_KEY);
    expect(serialized).not.toContain('authKey');
  });

  it('set_device_tailscale preview carries only the public projection, no key value', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'set_device_tailscale');

    const newKey = 'tskey-auth-replacement-456';
    const preview = await action.preview(CTX, {
      device_id: DEVICE_ID,
      hostname: 'mbp',
      auth_key: newKey,
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain(newKey);
    expect(serialized).not.toContain(AUTH_KEY);
    expect(serialized).toContain('hasAuthKey');
    expect(
      action.summary({ device_id: DEVICE_ID, hostname: 'mbp', auth_key: newKey }),
    ).not.toContain(newKey);
  });

  it('set_device_tailscale preview keeps hasAuthKey when the key is omitted', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'set_device_tailscale');

    const kept = await action.preview(CTX, { device_id: DEVICE_ID, hostname: 'mbp' });
    expect(JSON.stringify(kept.diff)).toContain('hasAuthKey: true');

    const cleared = await action.preview(CTX, {
      device_id: DEVICE_ID,
      hostname: 'mbp',
      auth_key: null,
    });
    expect(JSON.stringify(cleared.diff)).toContain('hasAuthKey: false');
  });
});

describe('device patch guardrails', () => {
  it('resolves *** placeholders back to stored secrets on whole-patch replace', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const update = requireWriteAction(DEVICE_WRITE_ACTIONS, 'update_device');

    mocks.patchDevice.mockResolvedValue(fixtureDevice());
    await update.execute(CTX, {
      id: DEVICE_ID,
      base_patch: { secret: '***', port: 1234 },
    });
    expect(mocks.patchDevice).toHaveBeenCalledWith('profile-test', DEVICE_ID, {
      base_patch: { secret: SECRET_VALUE, port: 1234 },
    });
    // The preview diff still shows the mask, never the resolved secret.
    const preview = await update.preview(CTX, {
      id: DEVICE_ID,
      base_patch: { secret: '***', port: 1234 },
    });
    expect(JSON.stringify(preview)).not.toContain(SECRET_VALUE);
  });

  it('rejects *** placeholders that nothing stored can back', async () => {
    const { DEVICE_READ_ACTIONS, DEVICE_WRITE_ACTIONS } =
      await import('@/lib/ai/actions/primitives/deviceWrites');
    const preview = requireReadAction(DEVICE_READ_ACTIONS, 'preview_device_config');
    const update = requireWriteAction(DEVICE_WRITE_ACTIONS, 'update_device');

    // Candidate-only preview: no stored patch exists to resolve against.
    await expect(preview.run(CTX, { base_patch: { secret: '***' } })).rejects.toThrow(/\*\*\*/);
    // Placeholder at a path the stored patch does not have.
    await expect(
      update.preview(CTX, { id: DEVICE_ID, base_patch: { 'auth-key': '***' } }),
    ).rejects.toThrow(/\*\*\*/);
    expect(mocks.patchDevice).not.toHaveBeenCalled();
  });

  it('preview_device_config surfaces invalid patches as structured issues, not errors', async () => {
    const { DEVICE_READ_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireReadAction(DEVICE_READ_ACTIONS, 'preview_device_config');

    mocks.buildDeviceConfig.mockImplementation(() => {
      throw new ConfigValidationError({
        code: 'device_patch_managed_key',
        message: '设备补丁不能修改 proxies。',
        section: 'devices',
        path: 'base_patch.proxies',
        resource: 'device',
      });
    });
    const invalid = await action.run(CTX, { base_patch: { proxies: [] } });
    const invalidData = invalid.data as { valid: boolean; issues: unknown[]; yaml: string | null };
    expect(invalidData.valid).toBe(false);
    expect(invalidData.issues).toHaveLength(1);
    expect(invalidData.yaml).toBeNull();

    mocks.buildDeviceConfig.mockReturnValue(
      'port: 7891\nproxies:\n  - {name: "[HK-01]", server: node.example.invalid, port: 48443, sni: tls.example.invalid}\n',
    );
    const valid = await action.run(CTX, { device_id: DEVICE_ID, include_yaml: true });
    const validData = valid.data as { valid: boolean; issues: unknown[]; yaml: string | null };
    expect(validData.valid).toBe(true);
    expect(validData.issues).toHaveLength(0);
    expect(validData.yaml).toContain('port: 7891');
    expect(validData.yaml).toContain('[HK-01]');
    expect(validData.yaml).not.toMatch(/node\.example\.invalid|tls\.example\.invalid|48443/);
    // Stored patch/features (with the real secret) went to the renderer,
    // never into the envelope.
    expect(mocks.buildDeviceConfig).toHaveBeenLastCalledWith(
      'port: 7890\n',
      fixtureDevice().base_patch,
      'macbook',
      expect.objectContaining({ tailscale: expect.objectContaining({ authKey: AUTH_KEY }) }),
    );
    expect(JSON.stringify(valid.data)).not.toContain(SECRET_VALUE);
  });
});

describe('device write actions', () => {
  it('create_device previews a redacted diff and executes through deviceService', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'create_device');

    const input = { name: 'iphone', base_patch: { secret: SECRET_VALUE } };
    const preview = await action.preview(CTX, input);
    const serialized = JSON.stringify(preview);
    expect(serialized).toContain('***');
    expect(serialized).not.toContain(SECRET_VALUE);

    mocks.createDevice.mockResolvedValue({ ...fixtureDevice(), id: 'new-id', name: 'iphone' });
    await action.execute(CTX, input);
    expect(mocks.createDevice).toHaveBeenCalledWith('profile-test', {
      name: 'iphone',
      base_patch: { secret: SECRET_VALUE },
    });
  });

  it('update_device passes null clears and whole-patch replacement to patchDevice', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'update_device');

    mocks.patchDevice.mockResolvedValue({ ...fixtureDevice(), name: 'macbook-air' });
    await action.execute(CTX, {
      id: DEVICE_ID,
      name: 'macbook-air',
      display_name: null,
      base_patch: {},
    });
    expect(mocks.patchDevice).toHaveBeenCalledWith('profile-test', DEVICE_ID, {
      name: 'macbook-air',
      display_name: null,
      base_patch: {},
    });
  });

  it('delete_device maps a service no-op to not-found', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'delete_device');

    mocks.deleteDevice.mockResolvedValue(false);
    await expect(action.execute(CTX, { id: DEVICE_ID })).rejects.toThrow(/不存在/);
  });

  it('set_device_tailscale maps snake_case input onto the typed camelCase payload', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'set_device_tailscale');

    mocks.putDeviceTailscaleFeature.mockResolvedValue({
      feature: { hostname: 'mbp', hasAuthKey: false },
      warnings: [],
    });
    const result = await action.execute(CTX, {
      device_id: DEVICE_ID,
      hostname: 'mbp',
      auth_key: null,
      accept_routes: false,
      exit_node: 'us-exit',
      extra_cidrs: ['10.0.0.0/24'],
    });
    expect(mocks.putDeviceTailscaleFeature).toHaveBeenCalledWith('profile-test', DEVICE_ID, {
      hostname: 'mbp',
      authKey: null,
      acceptRoutes: false,
      exitNode: 'us-exit',
      extraCidrs: ['10.0.0.0/24'],
    });
    expect(JSON.stringify(result)).not.toContain(AUTH_KEY);
  });

  it('remove_device_tailscale refuses to mint a card when the feature is absent', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'remove_device_tailscale');

    mocks.device = { ...fixtureDevice(), features: {} };
    await expect(action.preview(CTX, { device_id: DEVICE_ID })).rejects.toThrow(/未启用/);
  });
});

describe('additional Tailscale instances', () => {
  const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';

  function deviceWithInstances(): Device {
    return {
      ...fixtureDevice(),
      features: {
        tailscale: {
          hostname: 'mbp',
          authKey: AUTH_KEY,
          routeMode: 'service',
          serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
          ephemeral: false,
          acceptRoutes: true,
          udp: true,
          exitNodeAllowLanAccess: false,
          extraCidrs: [],
        },
        tailscaleInstances: [
          {
            id: INSTANCE_ID,
            hostname: 'mbp-extra',
            authKey: 'tskey-extra-secret',
            routeMode: 'service',
            serviceRoutes: [{ ip: '100.100.1.3', port: 8443 }],
            ephemeral: false,
            acceptRoutes: true,
            udp: true,
            exitNodeAllowLanAccess: false,
            extraCidrs: [],
          },
        ],
      },
    };
  }

  it('keeps the legacy tool scoped to the original slot and surfaces stored routing', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = deviceWithInstances();
    mocks.putDeviceTailscaleFeature.mockResolvedValue({
      feature: { hostname: 'mbp', hasAuthKey: true },
      warnings: [],
    });
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'set_device_tailscale');

    // Omitted service_routes must keep the stored allowlist in the card.
    const preview = await action.preview(CTX, { device_id: DEVICE_ID, hostname: 'mbp' });
    expect(preview.diff.afterYaml).toContain('100.100.1.2');
    expect(preview.diff.afterYaml).not.toContain('100.100.1.3');

    await action.execute(CTX, { device_id: DEVICE_ID, hostname: 'mbp' });
    expect(mocks.putDeviceTailscaleFeature).toHaveBeenCalledWith('profile-test', DEVICE_ID, {
      hostname: 'mbp',
    });
    expect(mocks.putDeviceTailscaleInstance).not.toHaveBeenCalled();
    expect(mocks.createDeviceTailscaleInstance).not.toHaveBeenCalled();
  });

  it('maps an explicit service switch and a null switch back to CIDR', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = fixtureDevice();
    mocks.putDeviceTailscaleFeature.mockResolvedValue({
      feature: { hostname: 'mbp', hasAuthKey: true },
      warnings: [],
    });
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'set_device_tailscale');

    await action.execute(CTX, {
      device_id: DEVICE_ID,
      hostname: 'mbp',
      service_routes: [{ ip: '100.100.1.2', port: 443 }],
    });
    expect(mocks.putDeviceTailscaleFeature).toHaveBeenLastCalledWith('profile-test', DEVICE_ID, {
      hostname: 'mbp',
      serviceRoutes: [{ ip: '100.100.1.2', port: 443 }],
    });

    await action.execute(CTX, { device_id: DEVICE_ID, hostname: 'mbp', service_routes: null });
    expect(mocks.putDeviceTailscaleFeature).toHaveBeenLastCalledWith('profile-test', DEVICE_ID, {
      hostname: 'mbp',
      serviceRoutes: null,
    });
  });

  it('refuses a legacy service that another instance already owns', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = deviceWithInstances();
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'set_device_tailscale');

    await expect(
      action.preview(CTX, {
        device_id: DEVICE_ID,
        hostname: 'mbp',
        service_routes: [{ ip: '100.100.1.3', port: 8443 }],
      }),
    ).rejects.toThrow(/100.100.1.3:8443/);
  });

  it('lists additional instances without leaking either key', async () => {
    const { DEVICE_READ_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = deviceWithInstances();
    mocks.listDeviceTailscaleInstances.mockResolvedValue({
      instances: [
        {
          id: INSTANCE_ID,
          hostname: 'mbp-extra',
          hasAuthKey: true,
          routeMode: 'service',
          serviceRoutes: [{ ip: '100.100.1.3', port: 8443 }],
        },
      ],
      warnings: [],
    });
    const action = requireReadAction(DEVICE_READ_ACTIONS, 'list_device_tailscale_instances');

    const result = await action.run(CTX, { device_id: DEVICE_ID });
    const serialized = JSON.stringify(result.data);
    expect(serialized).toContain('mbp-extra');
    expect(serialized).toContain('hasAuthKey');
    expect(serialized).not.toContain('tskey-extra-secret');
    expect(serialized).not.toContain(AUTH_KEY);
  });

  it('adds an instance through the instance service, not the legacy path', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = fixtureDevice();
    mocks.createDeviceTailscaleInstance.mockResolvedValue({
      instance: { id: INSTANCE_ID, hostname: 'mbp-extra', hasAuthKey: false },
      warnings: [],
    });
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'add_device_tailscale_instance');

    const preview = await action.preview(CTX, {
      device_id: DEVICE_ID,
      hostname: 'mbp-extra',
      service_routes: [{ ip: '100.100.1.4', port: 22 }],
    });
    expect(preview.diff.afterYaml).toContain('100.100.1.4');

    await action.execute(CTX, {
      device_id: DEVICE_ID,
      hostname: 'mbp-extra',
      service_routes: [{ ip: '100.100.1.4', port: 22 }],
      auth_key: 'tskey-new-instance',
    });
    expect(mocks.createDeviceTailscaleInstance).toHaveBeenCalledWith('profile-test', DEVICE_ID, {
      hostname: 'mbp-extra',
      serviceRoutes: [{ ip: '100.100.1.4', port: 22 }],
      authKey: 'tskey-new-instance',
    });
    expect(mocks.putDeviceTailscaleFeature).not.toHaveBeenCalled();
  });

  it('updates only the requested instance and reports the other one separately', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = deviceWithInstances();
    mocks.putDeviceTailscaleInstance.mockResolvedValue({
      instance: { id: INSTANCE_ID, hostname: 'mbp-extra-2', hasAuthKey: true },
      warnings: [],
    });
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'update_device_tailscale_instance');

    const preview = await action.preview(CTX, {
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
      hostname: 'mbp-extra-2',
    });
    expect(preview.diff.afterYaml).toContain('mbp-extra-2');
    expect(preview.diff.afterYaml).toContain('100.100.1.3');
    expect(preview.diff.afterYaml).not.toContain('100.100.1.2');

    await action.execute(CTX, {
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
      hostname: 'mbp-extra-2',
    });
    expect(mocks.putDeviceTailscaleInstance).toHaveBeenCalledWith(
      'profile-test',
      DEVICE_ID,
      INSTANCE_ID,
      { hostname: 'mbp-extra-2' },
    );
    expect(mocks.putDeviceTailscaleFeature).not.toHaveBeenCalled();
  });

  it('refuses an update that would reuse a destination already taken', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = deviceWithInstances();
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'update_device_tailscale_instance');

    await expect(
      action.preview(CTX, {
        device_id: DEVICE_ID,
        instance_id: INSTANCE_ID,
        service_routes: [{ ip: '100.100.1.2', port: 443 }],
      }),
    ).rejects.toThrow(/100.100.1.2:443/);
  });

  it('removes a single instance and leaves the legacy slot alone', async () => {
    const { DEVICE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/deviceWrites');
    mocks.device = deviceWithInstances();
    mocks.deleteDeviceTailscaleInstance.mockResolvedValue({ deleted: true, warnings: [] });
    const action = requireWriteAction(DEVICE_WRITE_ACTIONS, 'remove_device_tailscale_instance');

    const preview = await action.preview(CTX, {
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
    });
    expect(preview.diff.beforeYaml).toContain('mbp-extra');

    await action.execute(CTX, { device_id: DEVICE_ID, instance_id: INSTANCE_ID });
    expect(mocks.deleteDeviceTailscaleInstance).toHaveBeenCalledWith(
      'profile-test',
      DEVICE_ID,
      INSTANCE_ID,
    );
    expect(mocks.deleteDeviceTailscaleFeature).not.toHaveBeenCalled();
  });
});
