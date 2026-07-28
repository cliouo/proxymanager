import { ConfigPreflightUnavailableError } from '@/lib/config/errors';
import { ProblemDetailsError, PROBLEM_BASE_URL } from '@/lib/http/problem';
import {
  commitSetupBootstrap,
  inspectSetupRoot,
  inspectSetupStorage,
  type SetupRootInspection,
  type SetupStorageInspection,
} from '@/lib/repos/setupRepo';
import { computeEtag } from '@/lib/services/baseService';
import { preflightProfileConfig } from '@/lib/services/configPreflight';
import { buildStarterBlueprint, STARTER_PROFILE_ID } from '@/lib/setup/starterBlueprint';
import {
  BaseConfigSchema,
  ProfileSchema,
  ProxyGroupSchema,
  RuleSchema,
  SETUP_STARTER_VERSION,
  SetupBootstrapRequestSchema,
  SetupProvenanceSchema,
  type Profile,
  type ProxyGroup,
  type Rule,
  type SetupApiStatus,
  type SetupBootstrapApiResponse,
  type SetupBootstrapRequest,
  type SetupDiagnostic,
  type SetupProvenance,
} from '@/schemas';

const SNAPSHOT_ATTEMPTS = 3;
const BaseMetaSchema = BaseConfigSchema.omit({ content: true });

interface SetupSnapshot {
  revision: number;
  root: SetupRootInspection;
  profiles: Profile[];
  profile: Profile | null;
  targetProfileId: string;
  storage: SetupStorageInspection;
  proxyGroups: ProxyGroup[];
  rules: Rule[];
  invalidProfiles: number;
  invalidProxyGroups: number;
  invalidRules: number;
  defaultProfileCount: number;
  baseRecordValid: boolean;
  storedProvenance: SetupProvenance | null;
  provenanceRecordInvalid: boolean;
}

function parseIdHash<T>(
  raw: Record<string, unknown>,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  idOf: (value: T) => string,
): { values: T[]; invalid: number } {
  const values: T[] = [];
  let invalid = 0;
  for (const [id, value] of Object.entries(raw)) {
    const parsed = parse(value);
    if (!parsed.success || idOf(parsed.data) !== id) {
      invalid += 1;
      continue;
    }
    values.push(parsed.data);
  }
  return { values, invalid };
}

async function loadSetupSnapshot(): Promise<SetupSnapshot> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const root = await inspectSetupRoot();
      const parsedProfiles = parseIdHash(
        root.profilesRaw,
        (value) => ProfileSchema.safeParse(value),
        (profile) => profile.id,
      );
      const defaultProfiles = parsedProfiles.values.filter(
        (candidate) => candidate.name === 'default',
      );
      const profile = defaultProfiles.length === 1 ? defaultProfiles[0] : null;
      const targetProfileId = profile?.id ?? STARTER_PROFILE_ID;
      const storage = await inspectSetupStorage(targetProfileId);
      const after = await inspectSetupRoot();
      if (root.revisionValid && after.revisionValid && root.revision !== after.revision) {
        continue;
      }
      const rootSnapshotMatches =
        JSON.stringify(root.profilesRaw) === JSON.stringify(after.profilesRaw) &&
        JSON.stringify(root.provenanceRaw) === JSON.stringify(after.provenanceRaw);
      const stableRoot: SetupRootInspection = {
        ...root,
        revisionValid: root.revisionValid && after.revisionValid,
        profilesTypeValid: root.profilesTypeValid && after.profilesTypeValid && rootSnapshotMatches,
        provenanceTypeValid: root.provenanceTypeValid && after.provenanceTypeValid,
        commitStorageTypesValid: root.commitStorageTypesValid && after.commitStorageTypesValid,
      };

      const parsedGroups = parseIdHash(
        storage.proxyGroupsRaw,
        (value) => ProxyGroupSchema.safeParse(value),
        (group) => group.id,
      );
      const parsedRules = parseIdHash(
        storage.rulesRaw,
        (value) => RuleSchema.safeParse(value),
        (rule) => rule.id,
      );
      const parsedBaseMeta = BaseMetaSchema.safeParse(storage.baseMeta);
      const baseRecordValid =
        (!storage.baseContentPresent && !storage.baseMetaPresent) ||
        (storage.baseContentPresent &&
          storage.baseMetaPresent &&
          storage.baseContent !== null &&
          parsedBaseMeta.success &&
          parsedBaseMeta.data.etag === computeEtag(storage.baseContent));
      const parsedProvenance =
        root.provenanceRaw === null ? null : SetupProvenanceSchema.safeParse(root.provenanceRaw);

      return {
        revision: root.revision,
        root: stableRoot,
        profiles: parsedProfiles.values,
        profile,
        targetProfileId,
        storage,
        proxyGroups: parsedGroups.values,
        rules: parsedRules.values,
        invalidProfiles: parsedProfiles.invalid,
        invalidProxyGroups: parsedGroups.invalid,
        invalidRules: parsedRules.invalid,
        defaultProfileCount: defaultProfiles.length,
        baseRecordValid,
        storedProvenance: parsedProvenance?.success ? parsedProvenance.data : null,
        provenanceRecordInvalid: parsedProvenance !== null && !parsedProvenance.success,
      };
    } catch {
      // Never echo Upstash/transport error text: it may contain endpoint data.
      throw new ConfigPreflightUnavailableError();
    }
  }
  throw new ConfigPreflightUnavailableError();
}

function diagnostic(
  code: string,
  component: SetupDiagnostic['component'],
  message: string,
  repairable = false,
): SetupDiagnostic {
  return { code, component, message, repairable };
}

const REASON_DIAGNOSTICS: Record<string, Omit<SetupDiagnostic, 'code'>> = {
  config_version_invalid: {
    component: 'storage',
    message: 'The configuration revision record is invalid.',
    repairable: false,
  },
  storage_type_invalid: {
    component: 'storage',
    message: 'One or more setup records use an unexpected storage type.',
    repairable: false,
  },
  profile_schema_invalid: {
    component: 'profile',
    message: 'One or more raw profile records cannot be parsed safely.',
    repairable: false,
  },
  multiple_default_profiles: {
    component: 'profile',
    message: 'More than one profile claims the default name.',
    repairable: false,
  },
  default_profile_missing: {
    component: 'profile',
    message: 'Existing profile records do not include one unambiguous default profile.',
    repairable: false,
  },
  base_record_incomplete: {
    component: 'base',
    message: 'Only one part of the base record exists.',
    repairable: false,
  },
  base_record_invalid: {
    component: 'base',
    message: 'The stored base record cannot be parsed safely.',
    repairable: false,
  },
  proxy_group_schema_invalid: {
    component: 'proxy-groups',
    message: 'One or more proxy-group records cannot be parsed safely.',
    repairable: false,
  },
  proxy_groups_storage_type_invalid: {
    component: 'proxy-groups',
    message: 'The proxy-group records use an unexpected storage type.',
    repairable: false,
  },
  rule_schema_invalid: {
    component: 'rules',
    message: 'One or more rule records cannot be parsed safely.',
    repairable: false,
  },
  rules_storage_type_invalid: {
    component: 'rules',
    message: 'The rule records use an unexpected storage type.',
    repairable: false,
  },
  partial_resources_present: {
    component: 'storage',
    message: 'Partial profile resources already exist and will not be overwritten.',
    repairable: false,
  },
  profile_source_not_unbound: {
    component: 'profile',
    message: 'The incomplete default profile already references a node source.',
    repairable: false,
  },
  provenance_record_invalid: {
    component: 'provenance',
    message: 'The stored starter provenance record is invalid.',
    repairable: false,
  },
  orphaned_setup_provenance: {
    component: 'provenance',
    message: 'Starter provenance exists without a complete configured profile.',
    repairable: false,
  },
  base_missing: {
    component: 'base',
    message: 'The default profile is recoverable because its owned resources are empty.',
    repairable: true,
  },
  already_configured: {
    component: 'base',
    message: 'The default profile already owns a complete base configuration.',
    repairable: false,
  },
};

function exactStarterProvenance(snapshot: SetupSnapshot): SetupProvenance | null {
  const provenance = snapshot.storedProvenance;
  const profile = snapshot.profile;
  if (
    !provenance ||
    !profile ||
    !snapshot.storage.baseContentPresent ||
    snapshot.invalidProxyGroups > 0 ||
    snapshot.invalidRules > 0 ||
    snapshot.storage.typeIssues.includes('proxy-groups') ||
    snapshot.storage.typeIssues.includes('rules')
  ) {
    return null;
  }
  const expected = buildStarterBlueprint(0);
  const baseMeta = BaseMetaSchema.safeParse(snapshot.storage.baseMeta);
  if (
    provenance.completed_revision !== provenance.expected_revision + 1 ||
    provenance.completed_revision > snapshot.revision ||
    provenance.profile_id !== profile.id ||
    profile.name !== expected.profile.name ||
    profile.source.type !== 'none' ||
    (provenance.created && profile.notes !== expected.profile.notes) ||
    snapshot.storage.baseContent !== expected.baseContent ||
    !baseMeta.success ||
    baseMeta.data.etag !== provenance.base_etag ||
    provenance.base_etag !== expected.baseMeta.etag ||
    JSON.stringify(provenance.proxy_group_ids) !==
      JSON.stringify(expected.proxyGroups.map((group) => group.id)) ||
    JSON.stringify(provenance.rule_ids) !== JSON.stringify(expected.rules.map((rule) => rule.id))
  ) {
    return null;
  }

  const withoutTimes = (value: Record<string, unknown>) => {
    const rest = { ...value };
    delete rest.created_at;
    delete rest.updated_at;
    delete rest.added_at;
    return rest;
  };
  const actualGroups = snapshot.proxyGroups
    .map((group) => withoutTimes(group as unknown as Record<string, unknown>))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const expectedGroups = expected.proxyGroups
    .map((group) => withoutTimes(group as unknown as Record<string, unknown>))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const actualRules = snapshot.rules.map((rule) =>
    withoutTimes(rule as unknown as Record<string, unknown>),
  );
  const expectedRules = expected.rules.map((rule) =>
    withoutTimes(rule as unknown as Record<string, unknown>),
  );
  return JSON.stringify(actualGroups) === JSON.stringify(expectedGroups) &&
    JSON.stringify(actualRules) === JSON.stringify(expectedRules)
    ? provenance
    : null;
}

function statusFromSnapshot(snapshot: SetupSnapshot): SetupApiStatus {
  const rawProfilesTotal = Object.keys(snapshot.root.profilesRaw).length;
  const proxyGroupsTotal = Object.keys(snapshot.storage.proxyGroupsRaw).length;
  const rulesTotal = Object.keys(snapshot.storage.rulesRaw).length;
  const baseComplete =
    snapshot.storage.baseContentPresent &&
    snapshot.storage.baseMetaPresent &&
    snapshot.baseRecordValid;
  const blockingReasonCodes: string[] = [];
  const healthReasonCodes: string[] = [];
  const classificationReasonCodes: string[] = [];
  const proxyGroupsTypeInvalid = snapshot.storage.typeIssues.includes('proxy-groups');
  const rulesTypeInvalid = snapshot.storage.typeIssues.includes('rules');
  const baseStorageTypeInvalid = snapshot.storage.typeIssues.some(
    (issue) => issue === 'base-content' || issue === 'base-meta',
  );

  if (!snapshot.root.revisionValid) blockingReasonCodes.push('config_version_invalid');
  if (
    !snapshot.root.profilesTypeValid ||
    !snapshot.root.provenanceTypeValid ||
    !snapshot.root.commitStorageTypesValid ||
    baseStorageTypeInvalid
  ) {
    blockingReasonCodes.push('storage_type_invalid');
  }
  if (snapshot.invalidProfiles > 0) blockingReasonCodes.push('profile_schema_invalid');
  if (snapshot.defaultProfileCount > 1) blockingReasonCodes.push('multiple_default_profiles');
  if (snapshot.invalidProxyGroups > 0) healthReasonCodes.push('proxy_group_schema_invalid');
  if (proxyGroupsTypeInvalid) healthReasonCodes.push('proxy_groups_storage_type_invalid');
  if (snapshot.invalidRules > 0) healthReasonCodes.push('rule_schema_invalid');
  if (rulesTypeInvalid) healthReasonCodes.push('rules_storage_type_invalid');
  if (!snapshot.baseRecordValid) {
    blockingReasonCodes.push(
      snapshot.storage.baseContentPresent !== snapshot.storage.baseMetaPresent
        ? 'base_record_incomplete'
        : 'base_record_invalid',
    );
  }
  if (snapshot.provenanceRecordInvalid) {
    blockingReasonCodes.push('provenance_record_invalid');
  }

  let state: SetupApiStatus['state'] = 'blocked';
  if (blockingReasonCodes.length === 0) {
    if (rawProfilesTotal === 0) {
      const noOwnedResources =
        !snapshot.storage.baseContentPresent &&
        !snapshot.storage.baseMetaPresent &&
        proxyGroupsTotal === 0 &&
        rulesTotal === 0 &&
        !proxyGroupsTypeInvalid &&
        !rulesTypeInvalid;
      if (noOwnedResources && snapshot.root.provenanceRaw === null) {
        state = 'empty';
      } else {
        classificationReasonCodes.push(
          snapshot.root.provenanceRaw === null
            ? 'partial_resources_present'
            : 'orphaned_setup_provenance',
        );
      }
    } else if (!snapshot.profile) {
      classificationReasonCodes.push('default_profile_missing');
    } else if (baseComplete) {
      state = 'configured';
      classificationReasonCodes.push('already_configured');
    } else if (
      !snapshot.storage.baseContentPresent &&
      !snapshot.storage.baseMetaPresent &&
      proxyGroupsTotal === 0 &&
      rulesTotal === 0 &&
      !proxyGroupsTypeInvalid &&
      !rulesTypeInvalid &&
      snapshot.root.provenanceRaw === null &&
      snapshot.profile.source.type === 'none'
    ) {
      state = 'recoverable';
      classificationReasonCodes.push('base_missing');
    } else {
      classificationReasonCodes.push(
        snapshot.profile.source.type !== 'none'
          ? 'profile_source_not_unbound'
          : snapshot.root.provenanceRaw === null
            ? 'partial_resources_present'
            : 'orphaned_setup_provenance',
      );
    }
  }

  const reasonCodes = [
    ...blockingReasonCodes,
    ...healthReasonCodes,
    ...classificationReasonCodes,
  ];
  const diagnostics = reasonCodes.map((code) => {
    const known = REASON_DIAGNOSTICS[code] ?? {
      component: 'storage' as const,
      message: 'The setup state cannot be classified safely.',
      repairable: false,
    };
    return diagnostic(code, known.component, known.message, known.repairable);
  });
  return {
    state,
    can_bootstrap: state === 'empty' || state === 'recoverable',
    revision: snapshot.revision,
    starter_version: SETUP_STARTER_VERSION,
    reason_codes: reasonCodes,
    inventory: {
      profiles_total: rawProfilesTotal,
      profiles_valid: snapshot.profiles.length,
      profiles_invalid: snapshot.invalidProfiles,
      default_profile_id: snapshot.profile?.id ?? null,
      has_base: baseComplete,
      base_content_present: snapshot.storage.baseContentPresent,
      base_meta_present: snapshot.storage.baseMetaPresent,
      proxy_groups_total: proxyGroupsTotal,
      proxy_groups_invalid: snapshot.invalidProxyGroups,
      rules_total: rulesTotal,
      rules_invalid: snapshot.invalidRules,
      source_type: snapshot.profile?.source.type ?? null,
    },
    starter: {
      profile_name: 'default',
      listener_ports: 'client-managed',
      allow_lan: false,
      mode: 'rule',
      log_level: 'info',
      dns_enabled: false,
      tun_enabled: false,
      sniffer_enabled: false,
      rule_sets_total: 0,
      proxy_groups: [
        { name: '自动选择', type: 'url-test' },
        { name: '默认', type: 'select' },
      ],
      final_rule: 'MATCH,默认',
    },
    provenance: state === 'configured' ? exactStarterProvenance(snapshot) : null,
    diagnostics,
  };
}

function setupConflict(status: SetupApiStatus): ProblemDetailsError {
  return new ProblemDetailsError({
    type: `${PROBLEM_BASE_URL}/conflict`,
    title: 'Setup cannot be bootstrapped',
    status: 409,
    detail:
      status.state === 'configured'
        ? 'The default profile is already configured and will not be overwritten.'
        : 'The current storage state cannot be bootstrapped safely.',
    current_state: status.state,
    can_bootstrap: status.can_bootstrap,
    reason_codes: status.reason_codes,
  });
}

export async function getSetupStatus(): Promise<SetupApiStatus> {
  return statusFromSnapshot(await loadSetupSnapshot());
}

export async function bootstrapSetup(
  input: SetupBootstrapRequest,
): Promise<SetupBootstrapApiResponse> {
  const request = SetupBootstrapRequestSchema.parse(input);
  const snapshot = await loadSetupSnapshot();
  const status = statusFromSnapshot(snapshot);
  if (request.expected_revision !== snapshot.revision) {
    throw ProblemDetailsError.preconditionFailed(
      'Setup revision changed after status was read; fetch status and retry.',
    );
  }
  if (!status.can_bootstrap) throw setupConflict(status);

  const now = Math.floor(Date.now() / 1000);
  const starter = buildStarterBlueprint(now);
  const created = status.state === 'empty';
  const profile = snapshot.profile ?? starter.profile;
  const checked = await preflightProfileConfig(
    profile.id,
    () => ({
      proxyGroups: starter.proxyGroups,
      rules: starter.rules,
    }),
    {
      ...(created ? { initializeProfile: profile } : {}),
      initializeBaseContent: starter.baseContent,
    },
  );
  if (
    checked.configVersion !== request.expected_revision ||
    checked.profileExisted !== !created ||
    checked.baseExisted
  ) {
    throw ProblemDetailsError.preconditionFailed(
      'Setup state changed while the starter candidate was being validated; retry.',
    );
  }

  const committed = await commitSetupBootstrap({
    expectedVersion: checked.configVersion,
    profile,
    writeProfile: created,
    baseContent: starter.baseContent,
    baseMeta: starter.baseMeta,
    writeBase: true,
    proxyGroups: starter.proxyGroups,
    writeProxyGroups: true,
    rules: starter.rules,
    writeRules: true,
    buildId: checked.buildId,
    created,
  });
  if (!committed.ok) {
    if (committed.conflict === 'storage-type') {
      throw setupConflict({
        ...status,
        state: 'blocked',
        can_bootstrap: false,
        reason_codes: ['storage_type_invalid'],
      });
    }
    throw ProblemDetailsError.preconditionFailed(
      'Setup state changed before the atomic commit; retry.',
    );
  }

  const provenance = SetupProvenanceSchema.parse(committed.provenance);
  return {
    state: 'configured',
    created: provenance.created,
    revision: provenance.completed_revision,
    starter_version: provenance.starter_version,
    profile: {
      id: provenance.profile_id,
      name: 'default',
      source: { type: 'none' },
    },
    provenance,
    resources: {
      base_etag: provenance.base_etag,
      build_id: provenance.build_id,
      proxy_group_ids: provenance.proxy_group_ids,
      rule_ids: provenance.rule_ids,
    },
    readiness: {
      config_renderable: true,
      source: 'unbound',
      distribution_available: true,
    },
  };
}
