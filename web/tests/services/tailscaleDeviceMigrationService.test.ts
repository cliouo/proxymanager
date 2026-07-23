import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileConfigState } from '@/lib/services/configPreflight';

const mocks = vi.hoisted(() => ({
  getProfileByName: vi.fn(),
  preflightProfileConfig: vi.fn(),
  commitTailscaleDeviceMigration: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('@/lib/repos/profilesRepo', () => ({ getProfileByName: mocks.getProfileByName }));
vi.mock('@/lib/services/configPreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/configPreflight')>()),
  preflightProfileConfig: mocks.preflightProfileConfig,
}));
vi.mock('@/lib/repos/tailscaleDeviceMigrationRepo', () => ({
  commitTailscaleDeviceMigration: mocks.commitTailscaleDeviceMigration,
}));
vi.mock('@/lib/repos/auditRepo', () => ({ recordEvent: mocks.recordEvent }));

import {
  executeTailscaleDeviceMigration,
  planTailscaleDeviceMigration,
} from '@/lib/services/tailscaleDeviceMigrationService';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const RULE_ID = '44444444-4444-4444-8444-444444444444';

const BASE = `mixed-port: 7890
proxies:
  - name: old-ts
    type: tailscale
    hostname: server-ts
    auth-key: tskey-secret
    state-dir: ./ts-server
    udp: true
    accept-routes: true
proxy-groups: []
rules:
  # === ANCHOR: main ===
`;

function state(baseContent = BASE): ProfileConfigState {
  return {
    profile: {
      id: PROFILE_ID,
      name: 'home',
      source: { type: 'none' },
      kind: 'normal',
      updated_at: 1,
    },
    baseContent,
    subscriptions: [],
    templates: [],
    ruleSets: [],
    collections: [],
    proxyGroups: [
      {
        id: GROUP_ID,
        name: 'Tailscale',
        kind: 'raw',
        type: 'select',
        proxies: ['old-ts'],
        notes: 'tailscale: tailnet access group',
        rank: 10,
        updated_at: 1,
      },
    ],
    rules: [
      {
        id: RULE_ID,
        anchor: 'main',
        type: 'IP-CIDR',
        value: '100.64.0.0/10',
        policy: 'Tailscale',
        options: ['no-resolve'],
        source: 'manual',
        rank: 10,
        added_at: 1,
        updated_at: 1,
      },
    ],
    devices: [
      {
        id: DEVICE_ID,
        name: 'server',
        base_patch: {},
        features: {},
        created_at: 1,
        updated_at: 1,
      },
    ],
  };
}

let candidate: Partial<ProfileConfigState> | null = null;

describe('tailscaleDeviceMigrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    candidate = null;
    mocks.getProfileByName.mockResolvedValue(state().profile);
    mocks.preflightProfileConfig.mockImplementation(
      async (
        _profileId: string,
        build: (value: Readonly<ProfileConfigState>) => Partial<ProfileConfigState>,
      ) => {
        const current = state();
        candidate = await build(current);
        return { configVersion: 41, candidate: { ...current, ...candidate } };
      },
    );
    mocks.commitTailscaleDeviceMigration.mockResolvedValue({
      ok: true,
      currentVersion: 42,
    });
    mocks.recordEvent.mockResolvedValue(undefined);
  });

  it('plans one lossless move from shared artifacts into the selected device', async () => {
    const plan = await planTailscaleDeviceMigration('home', 'server');

    expect(plan.summary).toEqual(
      expect.objectContaining({
        nodeName: 'old-ts',
        groupName: 'Tailscale',
        hostname: 'server-ts',
        hasAuthKey: true,
        ruleCount: 1,
      }),
    );
    expect(candidate?.baseContent).not.toContain('type: tailscale');
    expect(candidate?.proxyGroups).toEqual([]);
    expect(candidate?.rules).toEqual([]);
    expect(candidate?.devices?.[0].features.tailscale).toMatchObject({
      hostname: 'server-ts',
      authKey: 'tskey-secret',
      nodeName: 'old-ts',
      groupName: 'Tailscale',
    });
    expect(plan.expectedVersion).toBe(41);
  });

  it('rejects an ambiguous base with more than one legacy Tailscale node', async () => {
    const second = BASE.replace(
      'proxy-groups: []',
      '  - {name: old-ts-2, type: tailscale, hostname: second}\nproxy-groups: []',
    );
    mocks.preflightProfileConfig.mockImplementation(
      async (
        _profileId: string,
        build: (value: Readonly<ProfileConfigState>) => Partial<ProfileConfigState>,
      ) => build(state(second)),
    );

    await expect(planTailscaleDeviceMigration('home', 'server')).rejects.toThrow(/2 个/);
  });

  it('fails closed when the old node has a field the device feature cannot preserve', async () => {
    const unsupported = BASE.replace('    udp: true', '    udp: true\n    interface-name: en0');
    mocks.preflightProfileConfig.mockImplementation(
      async (
        _profileId: string,
        build: (value: Readonly<ProfileConfigState>) => Partial<ProfileConfigState>,
      ) => build(state(unsupported)),
    );

    await expect(planTailscaleDeviceMigration('home', 'server')).rejects.toThrow(/interface-name/);
  });

  it('fails closed when a known legacy field has the wrong YAML type', async () => {
    const mistyped = BASE.replace('    udp: true', '    udp: "false"');
    mocks.preflightProfileConfig.mockImplementation(
      async (
        _profileId: string,
        build: (value: Readonly<ProfileConfigState>) => Partial<ProfileConfigState>,
      ) => build(state(mistyped)),
    );

    await expect(planTailscaleDeviceMigration('home', 'server')).rejects.toThrow(/udp.*不是布尔值/);
  });

  it('fails closed when migration would move Tailscale rules across another rule', async () => {
    const orderedState = state(
      `mixed-port: 7890
proxies:
  - name: old-ts
    type: tailscale
    hostname: server-ts
proxy-groups: []
rules:
  # === ANCHOR: early ===
  # === ANCHOR: late ===
`,
    );
    orderedState.rules = [
      {
        ...orderedState.rules[0],
        id: '55555555-5555-4555-8555-555555555555',
        anchor: 'early',
        value: '10.0.0.0/8',
        policy: 'DIRECT',
        rank: 10,
      },
      { ...orderedState.rules[0], anchor: 'late', rank: 10 },
      {
        ...orderedState.rules[0],
        id: '66666666-6666-4666-8666-666666666666',
        anchor: 'late',
        type: 'MATCH',
        value: '',
        policy: 'DIRECT',
        options: undefined,
        rank: 20,
      },
    ];
    mocks.preflightProfileConfig.mockImplementation(
      async (
        _profileId: string,
        build: (value: Readonly<ProfileConfigState>) => Partial<ProfileConfigState>,
      ) => build(orderedState),
    );

    await expect(planTailscaleDeviceMigration('home', 'server')).rejects.toThrow(/改变规则优先级/);
  });

  it('executes the preflighted plan in one CAS commit and audits no credential', async () => {
    const plan = await planTailscaleDeviceMigration('home', 'server');
    await executeTailscaleDeviceMigration(plan);

    expect(mocks.commitTailscaleDeviceMigration).toHaveBeenCalledTimes(1);
    expect(mocks.commitTailscaleDeviceMigration.mock.calls[0][1]).toMatchObject({
      expectedVersion: 41,
      ruleDeletes: [RULE_ID],
      proxyGroupDeletes: [GROUP_ID],
    });
    const event = mocks.recordEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      op: 'device.tailscale.migrate',
      undoable: false,
      after: { hostname: 'server-ts', hasAuthKey: true },
    });
    expect(JSON.stringify(event)).not.toContain('tskey-secret');
  });

  it('reports a lost CAS race without claiming a migration', async () => {
    const plan = await planTailscaleDeviceMigration('home', 'server');
    mocks.commitTailscaleDeviceMigration.mockResolvedValue({
      ok: false,
      currentVersion: 99,
    });

    await expect(executeTailscaleDeviceMigration(plan)).rejects.toMatchObject({
      problem: { status: 412 },
    });
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('reports a storage-shape guard failure without claiming a version race', async () => {
    const plan = await planTailscaleDeviceMigration('home', 'server');
    mocks.commitTailscaleDeviceMigration.mockResolvedValue({
      ok: false,
      currentVersion: null,
      conflict: 'storage',
    });

    await expect(executeTailscaleDeviceMigration(plan)).rejects.toMatchObject({
      problem: { status: 409, detail: expect.stringContaining('存储结构异常') },
    });
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('does not report the committed migration as failed when only audit storage is down', async () => {
    const plan = await planTailscaleDeviceMigration('home', 'server');
    mocks.recordEvent.mockRejectedValue(new Error('audit unavailable'));

    await expect(executeTailscaleDeviceMigration(plan)).resolves.toEqual({
      backupKey: plan.backupKey,
      auditRecorded: false,
    });
  });
});
