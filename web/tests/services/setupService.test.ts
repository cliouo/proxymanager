import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileConfigState } from '@/lib/services/configPreflight';
import { buildStarterBlueprint, STARTER_PROFILE_ID } from '@/lib/setup/starterBlueprint';

const mocks = vi.hoisted(() => ({
  inspectSetupRoot: vi.fn(),
  inspectSetupStorage: vi.fn(),
  preflightProfileConfig: vi.fn(),
  commitSetupBootstrap: vi.fn(),
}));

vi.mock('@/lib/repos/setupRepo', () => ({
  inspectSetupRoot: mocks.inspectSetupRoot,
  inspectSetupStorage: mocks.inspectSetupStorage,
  commitSetupBootstrap: mocks.commitSetupBootstrap,
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: mocks.preflightProfileConfig,
}));

import { ConfigPreflightUnavailableError, ConfigValidationError } from '@/lib/config/errors';
import { ProblemDetailsError } from '@/lib/http/problem';
import type { SetupRootInspection } from '@/lib/repos/setupRepo';
import { computeEtag } from '@/lib/services/baseService';
import { bootstrapSetup, getSetupStatus } from '@/lib/services/setupService';
import type { Profile, SetupProvenance } from '@/schemas';

const STARTER = buildStarterBlueprint(1_700_000_000);
const PROFILE = STARTER.profile;
const EMPTY_ROOT: SetupRootInspection = {
  revision: 0,
  revisionValid: true,
  profilesRaw: {},
  profilesTypeValid: true,
  provenanceRaw: null,
  provenanceTypeValid: true,
  commitStorageTypesValid: true,
};
const EMPTY_STORAGE = {
  baseContentPresent: false,
  baseMetaPresent: false,
  baseContent: null,
  baseMeta: null,
  proxyGroupsRaw: {},
  rulesRaw: {},
  typeIssues: [],
};

function request(expectedRevision = 0) {
  return {
    expected_revision: expectedRevision,
    starter_version: 'starter-v1' as const,
  };
}

function root(
  profiles: Profile[] = [],
  overrides: Partial<SetupRootInspection> = {},
): SetupRootInspection {
  return {
    ...EMPTY_ROOT,
    profilesRaw: Object.fromEntries(profiles.map((profile) => [profile.id, profile])),
    ...overrides,
  };
}

function completeStorage(starter = STARTER) {
  return {
    ...EMPTY_STORAGE,
    baseContentPresent: true,
    baseMetaPresent: true,
    baseContent: starter.baseContent,
    baseMeta: starter.baseMeta,
    proxyGroupsRaw: Object.fromEntries(starter.proxyGroups.map((group) => [group.id, group])),
    rulesRaw: Object.fromEntries(starter.rules.map((rule) => [rule.id, rule])),
  };
}

function provenance(overrides: Partial<SetupProvenance> = {}): SetupProvenance {
  return {
    starter_version: 'starter-v1',
    expected_revision: 0,
    completed_revision: 1,
    created: true,
    profile_id: PROFILE.id,
    base_etag: STARTER.baseMeta.etag,
    build_id: 'abcdef12',
    proxy_group_ids: STARTER.proxyGroups.map((group) => group.id),
    rule_ids: STARTER.rules.map((rule) => rule.id),
    audit_event_id: '35000000-0000-4000-8000-000000000099',
    ...overrides,
  };
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ProblemDetailsError ? error.problem.status : undefined;
}

function installPreflight(profileExisted: boolean): void {
  mocks.preflightProfileConfig.mockImplementation(
    async (
      profileId: string,
      buildCandidate: (state: ProfileConfigState) => Partial<ProfileConfigState>,
      options: { initializeProfile?: Profile; initializeBaseContent?: string },
    ) => {
      const current = {
        profile: profileExisted ? PROFILE : options.initializeProfile!,
        baseContent: options.initializeBaseContent!,
        rules: [],
        subscriptions: [],
        proxyGroups: [],
        templates: [],
        ruleSets: [],
        collections: [],
        devices: [],
      } as ProfileConfigState;
      expect(profileId).toBe(current.profile.id);
      const patch = await buildCandidate(current);
      return {
        configVersion: 0,
        profileExisted,
        baseExisted: false,
        candidate: { ...current, ...patch },
        buildId: 'abcdef12',
      };
    },
  );
}

describe('setupService status classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectSetupRoot.mockResolvedValue(EMPTY_ROOT);
    mocks.inspectSetupStorage.mockResolvedValue(EMPTY_STORAGE);
    mocks.commitSetupBootstrap.mockResolvedValue({
      ok: true,
      currentVersion: 1,
      provenance: provenance(),
    });
    installPreflight(false);
  });

  it('derives the empty contract from raw storage inventory', async () => {
    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'empty',
      can_bootstrap: true,
      revision: 0,
      starter_version: 'starter-v1',
      reason_codes: [],
      inventory: {
        profiles_total: 0,
        profiles_invalid: 0,
        default_profile_id: null,
        has_base: false,
        proxy_groups_total: 0,
        rules_total: 0,
        source_type: null,
      },
      starter: {
        listener_ports: 'client-managed',
        allow_lan: false,
        dns_enabled: false,
        tun_enabled: false,
        sniffer_enabled: false,
        final_rule: 'MATCH,默认',
      },
      provenance: null,
    });
  });

  it('blocks when a raw profile record fails schema parsing instead of treating it as empty', async () => {
    mocks.inspectSetupRoot.mockResolvedValue({
      ...EMPTY_ROOT,
      profilesRaw: { broken: { id: 'not-a-uuid', name: 'legacy' } },
    });

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'blocked',
      can_bootstrap: false,
      reason_codes: expect.arrayContaining(['profile_schema_invalid']),
      inventory: {
        profiles_total: 1,
        profiles_valid: 0,
        profiles_invalid: 1,
      },
    });
  });

  it('blocks WRONGTYPE and invalid revision records without leaking storage details', async () => {
    mocks.inspectSetupRoot.mockResolvedValue({
      ...EMPTY_ROOT,
      revisionValid: false,
      profilesTypeValid: false,
    });

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'blocked',
      reason_codes: expect.arrayContaining(['config_version_invalid', 'storage_type_invalid']),
    });
    expect(JSON.stringify(status)).not.toContain('WRONGTYPE');
    expect(JSON.stringify(status)).not.toContain('redis:');
  });

  it('blocks other profiles when no unambiguous default exists', async () => {
    const other = {
      ...PROFILE,
      id: '35000000-0000-4000-8000-000000000098',
      name: 'other',
    };
    mocks.inspectSetupRoot.mockResolvedValue(root([other]));

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'blocked',
      can_bootstrap: false,
      reason_codes: ['default_profile_missing'],
      inventory: { profiles_total: 1, default_profile_id: null },
    });
  });

  it('marks only an empty owned default as recoverable', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(root([PROFILE]));

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'recoverable',
      can_bootstrap: true,
      reason_codes: ['base_missing'],
      inventory: { default_profile_id: PROFILE.id, has_base: false },
    });
  });

  it('blocks a missing base when user-owned groups are already present', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(root([PROFILE]));
    mocks.inspectSetupStorage.mockResolvedValue({
      ...EMPTY_STORAGE,
      proxyGroupsRaw: {
        [STARTER.proxyGroups[0].id]: STARTER.proxyGroups[0],
      },
    });

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'blocked',
      can_bootstrap: false,
      reason_codes: expect.arrayContaining(['partial_resources_present']),
    });
  });

  it.each(['proxy-groups', 'rules'] as const)(
    'blocks pre-bootstrap %s WRONGTYPE as unsafe partial storage',
    async (typeIssue) => {
      mocks.inspectSetupRoot.mockResolvedValue(root([PROFILE]));
      mocks.inspectSetupStorage.mockResolvedValue({
        ...EMPTY_STORAGE,
        typeIssues: [typeIssue],
      });

      const status = await getSetupStatus();

      expect(status).toMatchObject({
        state: 'blocked',
        can_bootstrap: false,
        reason_codes: expect.arrayContaining(['partial_resources_present']),
        provenance: null,
      });
    },
  );

  it('treats any complete existing default base as configured without starter claims', async () => {
    const customContent = 'mixed-port: 1443\nrules: []\n';
    const custom = {
      ...EMPTY_STORAGE,
      baseContentPresent: true,
      baseMetaPresent: true,
      baseContent: customContent,
      baseMeta: {
        etag: computeEtag(customContent),
        anchors: [],
        policies: [],
        updated_at: 1,
      },
    };
    mocks.inspectSetupRoot.mockResolvedValue(root([PROFILE], { revision: 8 }));
    mocks.inspectSetupStorage.mockResolvedValue(custom);

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      can_bootstrap: false,
      revision: 8,
      reason_codes: ['already_configured'],
      provenance: null,
      inventory: { has_base: true, proxy_groups_total: 0, rules_total: 0 },
    });
  });

  it('does not treat reordered profile hash fields as a storage type failure', async () => {
    const other = {
      ...PROFILE,
      id: '35000000-0000-4000-8000-000000000097',
      name: 'other',
    };
    mocks.inspectSetupRoot
      .mockResolvedValueOnce(root([PROFILE, other], { revision: 8 }))
      .mockResolvedValueOnce(root([other, PROFILE], { revision: 8 }));
    mocks.inspectSetupStorage.mockResolvedValue(completeStorage());

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      can_bootstrap: false,
      revision: 8,
      reason_codes: ['already_configured'],
      inventory: {
        profiles_total: 2,
        profiles_valid: 2,
        default_profile_id: PROFILE.id,
        has_base: true,
      },
    });
  });

  it('keeps a complete default configured when a raw proxy-group is invalid', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(
      root([PROFILE], { revision: 1, provenanceRaw: provenance() }),
    );
    const storage = completeStorage();
    (storage.proxyGroupsRaw as Record<string, unknown>)[
      '35000000-0000-4000-8000-000000000091'
    ] = {
      id: '35000000-0000-4000-8000-000000000091',
      name: 'broken',
      type: 'not-a-proxy-group-type',
    };
    mocks.inspectSetupStorage.mockResolvedValue(storage);

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      can_bootstrap: false,
      reason_codes: expect.arrayContaining([
        'proxy_group_schema_invalid',
        'already_configured',
      ]),
      inventory: { has_base: true, proxy_groups_invalid: 1 },
      provenance: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'proxy_group_schema_invalid',
          component: 'proxy-groups',
        }),
      ]),
    });
  });

  it('keeps a complete default configured when a raw rule is invalid', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(
      root([PROFILE], { revision: 1, provenanceRaw: provenance() }),
    );
    const storage = completeStorage();
    (storage.rulesRaw as Record<string, unknown>)[
      '35000000-0000-4000-8000-000000000092'
    ] = {
      id: '35000000-0000-4000-8000-000000000092',
      anchor: 'manual',
      type: 'NOT-A-RULE',
    };
    mocks.inspectSetupStorage.mockResolvedValue(storage);

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      can_bootstrap: false,
      reason_codes: expect.arrayContaining(['rule_schema_invalid', 'already_configured']),
      inventory: { has_base: true, rules_invalid: 1 },
      provenance: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'rule_schema_invalid', component: 'rules' }),
      ]),
    });
  });

  it('keeps a complete default configured when the proxy-group key has WRONGTYPE', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(
      root([PROFILE], { revision: 1, provenanceRaw: provenance() }),
    );
    mocks.inspectSetupStorage.mockResolvedValue({
      ...completeStorage(),
      proxyGroupsRaw: {},
      typeIssues: ['proxy-groups'],
    });

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      can_bootstrap: false,
      reason_codes: expect.arrayContaining([
        'proxy_groups_storage_type_invalid',
        'already_configured',
      ]),
      inventory: { has_base: true, proxy_groups_total: 0 },
      provenance: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'proxy_groups_storage_type_invalid',
          component: 'proxy-groups',
        }),
      ]),
    });
  });

  it('keeps a complete default configured when the rule key has WRONGTYPE', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(
      root([PROFILE], { revision: 1, provenanceRaw: provenance() }),
    );
    mocks.inspectSetupStorage.mockResolvedValue({
      ...completeStorage(),
      rulesRaw: {},
      typeIssues: ['rules'],
    });

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      can_bootstrap: false,
      reason_codes: expect.arrayContaining([
        'rules_storage_type_invalid',
        'already_configured',
      ]),
      inventory: { has_base: true, rules_total: 0 },
      provenance: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'rules_storage_type_invalid',
          component: 'rules',
        }),
      ]),
    });
  });

  it('blocks a corrupt base metadata etag while preserving its inventory', async () => {
    const storage = completeStorage();
    storage.baseMeta = { ...STARTER.baseMeta, etag: '0000000000000000' };
    mocks.inspectSetupRoot.mockResolvedValue(root([PROFILE]));
    mocks.inspectSetupStorage.mockResolvedValue(storage);

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'blocked',
      can_bootstrap: false,
      reason_codes: ['base_record_invalid'],
      inventory: {
        base_content_present: true,
        base_meta_present: true,
        has_base: false,
      },
    });
  });

  it('exposes provenance only while every starter-owned resource still matches', async () => {
    const receipt = provenance();
    mocks.inspectSetupRoot.mockResolvedValue(
      root([PROFILE], { revision: 1, provenanceRaw: receipt }),
    );
    mocks.inspectSetupStorage.mockResolvedValue(completeStorage());

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      provenance: receipt,
      inventory: { proxy_groups_total: 2, rules_total: 1 },
    });
  });

  it('confirms a recoverable bootstrap without requiring the preserved profile notes', async () => {
    const preservedProfile = { ...PROFILE, notes: 'user-owned profile metadata' };
    const receipt = provenance({ created: false, profile_id: preservedProfile.id });
    mocks.inspectSetupRoot.mockResolvedValue(
      root([preservedProfile], { revision: 1, provenanceRaw: receipt }),
    );
    mocks.inspectSetupStorage.mockResolvedValue(completeStorage());

    const status = await getSetupStatus();

    expect(status).toMatchObject({
      state: 'configured',
      provenance: { created: false, profile_id: preservedProfile.id },
    });
  });

  it('does not expose stale provenance after an exact starter resource changes', async () => {
    const receipt = provenance();
    mocks.inspectSetupRoot.mockResolvedValue(
      root([PROFILE], { revision: 2, provenanceRaw: receipt }),
    );
    const storage = completeStorage();
    storage.proxyGroupsRaw[STARTER.proxyGroups[0].id] = {
      ...STARTER.proxyGroups[0],
      interval: 999,
    };
    mocks.inspectSetupStorage.mockResolvedValue(storage);

    const status = await getSetupStatus();

    expect(status).toMatchObject({ state: 'configured', provenance: null });
  });

  it('maps Redis availability failures to a fixed 503 class', async () => {
    mocks.inspectSetupRoot.mockRejectedValue(new Error('https://secret.redis.invalid'));

    await expect(getSetupStatus()).rejects.toBeInstanceOf(ConfigPreflightUnavailableError);
  });

  it('retries a mixed revision read and returns only the stable snapshot revision', async () => {
    mocks.inspectSetupRoot
      .mockResolvedValueOnce({ ...EMPTY_ROOT, revision: 1 })
      .mockResolvedValueOnce({ ...EMPTY_ROOT, revision: 2 })
      .mockResolvedValueOnce({ ...EMPTY_ROOT, revision: 2 })
      .mockResolvedValueOnce({ ...EMPTY_ROOT, revision: 2 });

    const status = await getSetupStatus();

    expect(status).toMatchObject({ state: 'empty', revision: 2 });
    expect(mocks.inspectSetupStorage).toHaveBeenCalledTimes(2);
  });
});

describe('setupService bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectSetupRoot.mockResolvedValue(EMPTY_ROOT);
    mocks.inspectSetupStorage.mockResolvedValue(EMPTY_STORAGE);
    mocks.commitSetupBootstrap.mockResolvedValue({
      ok: true,
      currentVersion: 1,
      provenance: provenance(),
    });
    installPreflight(false);
  });

  it('preflights and atomically commits the client-managed listener starter', async () => {
    const requestedStarter = buildStarterBlueprint(1_700_000_000);
    mocks.commitSetupBootstrap.mockResolvedValue({
      ok: true,
      currentVersion: 1,
      provenance: provenance({
        base_etag: requestedStarter.baseMeta.etag,
      }),
    });
    const result = await bootstrapSetup(request(0));

    expect(result).toMatchObject({
      state: 'configured',
      created: true,
      revision: 1,
      starter_version: 'starter-v1',
      profile: { id: STARTER_PROFILE_ID, name: 'default', source: { type: 'none' } },
      provenance: {
        starter_version: 'starter-v1',
        expected_revision: 0,
        completed_revision: 1,
        created: true,
        profile_id: STARTER_PROFILE_ID,
        base_etag: expect.stringMatching(/^[0-9a-f]{16}$/u),
        build_id: 'abcdef12',
        proxy_group_ids: STARTER.proxyGroups.map((group) => group.id),
        rule_ids: STARTER.rules.map((rule) => rule.id),
      },
      resources: {
        base_etag: expect.stringMatching(/^[0-9a-f]{16}$/u),
        build_id: 'abcdef12',
        proxy_group_ids: STARTER.proxyGroups.map((group) => group.id),
        rule_ids: STARTER.rules.map((rule) => rule.id),
      },
      readiness: {
        config_renderable: true,
        source: 'unbound',
        distribution_available: true,
      },
    });
    expect(mocks.preflightProfileConfig).toHaveBeenCalledWith(
      STARTER_PROFILE_ID,
      expect.any(Function),
      expect.objectContaining({
        initializeProfile: expect.objectContaining({ id: STARTER_PROFILE_ID }),
        initializeBaseContent: expect.not.stringMatching(
          /^(?:mixed-port|port|socks-port):/mu,
        ),
      }),
    );
    expect(mocks.commitSetupBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 0,
        writeProfile: true,
        writeBase: true,
        writeProxyGroups: true,
        writeRules: true,
        buildId: 'abcdef12',
        created: true,
      }),
    );
  });

  it('recovers an empty default based only on server-derived status', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(root([PROFILE]));
    mocks.commitSetupBootstrap.mockResolvedValue({
      ok: true,
      currentVersion: 1,
      provenance: provenance({ created: false }),
    });
    installPreflight(true);

    const result = await bootstrapSetup(request());

    expect(result.created).toBe(false);
    expect(mocks.commitSetupBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ writeProfile: false, created: false }),
    );
  });

  it('rejects a stale expected revision before preflight', async () => {
    mocks.inspectSetupRoot.mockResolvedValue({ ...EMPTY_ROOT, revision: 9 });

    const error = await bootstrapSetup(request(8)).catch((caught) => caught);

    expect(statusOf(error)).toBe(412);
    expect(mocks.preflightProfileConfig).not.toHaveBeenCalled();
    expect(mocks.commitSetupBootstrap).not.toHaveBeenCalled();
  });

  it('returns 409 for configured or blocked storage instead of claiming idempotent success', async () => {
    mocks.inspectSetupRoot.mockResolvedValue(root([PROFILE]));
    mocks.inspectSetupStorage.mockResolvedValue(completeStorage());

    const error = await bootstrapSetup(request()).catch((caught) => caught);

    expect(statusOf(error)).toBe(409);
    expect((error as ProblemDetailsError).problem).toMatchObject({
      current_state: 'configured',
      can_bootstrap: false,
    });
    expect(mocks.commitSetupBootstrap).not.toHaveBeenCalled();
  });

  it('does not commit an invalid final starter candidate', async () => {
    mocks.preflightProfileConfig.mockRejectedValue(
      new ConfigValidationError({
        code: 'final_config_invalid',
        message: 'Candidate is invalid.',
        section: 'config',
        path: '$',
        resource: 'rendered-config',
      }),
    );

    await expect(bootstrapSetup(request())).rejects.toBeInstanceOf(ConfigValidationError);
    expect(mocks.commitSetupBootstrap).not.toHaveBeenCalled();
  });

  it('maps atomic CAS and presence conflicts to 412', async () => {
    mocks.commitSetupBootstrap.mockResolvedValue({
      ok: false,
      conflict: 'config-version',
      currentVersion: 1,
    });

    const error = await bootstrapSetup(request()).catch((caught) => caught);

    expect(statusOf(error)).toBe(412);
    expect(mocks.commitSetupBootstrap).toHaveBeenCalledTimes(1);
  });

  it('maps atomic storage corruption to a safe 409', async () => {
    mocks.commitSetupBootstrap.mockResolvedValue({
      ok: false,
      conflict: 'storage-type',
      currentVersion: null,
    });

    const error = await bootstrapSetup(request()).catch((caught) => caught);

    expect(statusOf(error)).toBe(409);
    expect(JSON.stringify((error as ProblemDetailsError).problem)).not.toContain('WRONGTYPE');
  });

  it('maps atomic Redis availability failure to 503 without leaking its message', async () => {
    mocks.commitSetupBootstrap.mockRejectedValue(new ConfigPreflightUnavailableError());

    await expect(bootstrapSetup(request())).rejects.toBeInstanceOf(ConfigPreflightUnavailableError);
  });
});
