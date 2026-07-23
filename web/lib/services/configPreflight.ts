import { ConfigPreflightUnavailableError, ConfigValidationError } from '@/lib/config/errors';
import { buildDeviceConfig } from '@/lib/engine/devicePatch';
import { resolveConfig } from '@/lib/engine/resolve';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { listDevices } from '@/lib/repos/devicesRepo';
import { getProfile } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import {
  describeSubscriptionContentIssue,
  SubscriptionResolutionValidationError,
  SubscriptionUpstreamUnavailableError,
} from '@/lib/services/subscriptionResolutionErrors';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import type { FetchSubscriptionProxiesResult } from '@/lib/services/subscriptionFetcher';
import type {
  Collection,
  Device,
  Profile,
  ProxyGroup,
  ProxyGroupTemplate,
  Rule,
  RuleSet,
  Subscription,
} from '@/schemas';

/** A complete, storage-independent view of one profile's render inputs. */
export interface ProfileConfigState {
  profile: Profile;
  baseContent: string;
  rules: Rule[];
  subscriptions: Subscription[];
  proxyGroups: ProxyGroup[];
  templates: ProxyGroupTemplate[];
  ruleSets: RuleSet[];
  collections: Collection[];
  /**
   * The profile's devices. Not a render input for the SHARED config — the
   * shared render never sees them — but every device's patch must still be
   * valid against whatever the candidate renders to, so they belong in the
   * state a preflight brackets and validates.
   *
   * A device mutation replaces this array in its candidate; a shared-layer
   * mutation leaves it alone and thereby re-validates every stored device.
   */
  devices: Device[];
}

export type ProfileConfigCandidate = Partial<Omit<ProfileConfigState, 'profile'>>;

export interface ConfigPreflightResult {
  /** Global generation that the returned candidate was built from. */
  configVersion: number;
  /** Exact in-memory state that passed the final render validator. */
  candidate: ProfileConfigState;
}

export type ConfigCandidateBuilder = (
  current: Readonly<ProfileConfigState>,
) => ProfileConfigCandidate | Promise<ProfileConfigCandidate>;

const SNAPSHOT_READ_ATTEMPTS = 3;

/** Side-effect-free, fresh-only subscription boundary shared by all preflights. */
export async function resolveSubscriptionForPreflight(
  subscription: Subscription,
): Promise<FetchSubscriptionProxiesResult> {
  try {
    return await resolveSubscriptionProxies(subscription, {
      writeCache: false,
      allowStale: false,
    });
  } catch (error) {
    if (error instanceof SubscriptionResolutionValidationError) {
      const rootPath = `subscriptions[${subscription.name}]`;
      const issue =
        error.stage === 'operators'
          ? {
              message: 'A subscription operator pipeline is invalid.',
              path: `${rootPath}.operators`,
            }
          : error.stage === 'definition'
            ? {
                message: 'A subscription definition is invalid.',
                path: rootPath,
              }
            : {
                message: 'A subscription contains invalid proxy nodes.',
                path: `${rootPath}.content`,
              };
      if (error.nodeIssue && error.stage !== 'definition') {
        const { index, field, reason } = error.nodeIssue;
        const nodePath = `${issue.path}.proxies[${index}]`;
        const subject =
          error.stage === 'operators'
            ? 'A subscription operator pipeline produced an invalid proxy node'
            : 'A subscription contains an invalid proxy node';
        issue.message = `${subject}: ${field === '<entry>' ? reason : `field "${field}" ${reason}`}.`;
        issue.path = field === '<entry>' ? nodePath : `${nodePath}.${field}`;
      } else if (error.contentIssue && error.stage === 'content') {
        issue.message = describeSubscriptionContentIssue(error.contentIssue);
        if (error.contentIssue.kind === 'proxy_node_limit_exceeded') {
          issue.path = `${rootPath}.content.proxies`;
        } else if (error.contentIssue.kind === 'uri_list_invalid') {
          const firstLine = error.contentIssue.samples[0]?.line;
          if (firstLine !== null && firstLine !== undefined) {
            issue.path = `${rootPath}.content.lines[${firstLine}]`;
          }
        }
      }
      throw new ConfigValidationError({
        code: error.code,
        message: issue.message,
        section: 'subscriptions',
        path: issue.path,
        resource: 'subscription',
      });
    }
    if (error instanceof SubscriptionUpstreamUnavailableError) {
      // Never echo the upstream error: it can contain credentials or a URL.
      // The handler maps this fixed error to a safe 503 response.
      throw new ConfigPreflightUnavailableError();
    }
    throw error;
  }
}

/**
 * Validate the exact final Mihomo document a mutation would produce, before
 * any storage write occurs.
 *
 * Reads are bracketed by config:version so a mixed snapshot is retried. The
 * final version is returned to the commit layer for an atomic compare-and-set;
 * this closes the remaining race between a successful preflight and commit.
 *
 * Preflight may read a fresh fetch-cache entry, but it never writes the fetch
 * cache, resolved snapshot, or render cache. An expired entry is not accepted
 * as proof: if its remote source cannot refresh, validation is reported as
 * temporarily unavailable rather than valid or invalid.
 */
export async function preflightProfileConfig(
  profileId: string,
  buildCandidate: ConfigCandidateBuilder,
): Promise<ConfigPreflightResult> {
  const { version, state } = await loadStableProfileState(profileId);
  const patch = await buildCandidate(state);
  const candidate: ProfileConfigState = { ...state, ...patch };

  try {
    const resolved = await resolveConfig(
      candidate.baseContent,
      candidate.rules,
      candidate.subscriptions,
      candidate.proxyGroups,
      candidate.templates,
      {
        providers: candidate.ruleSets,
        collections: candidate.collections,
        boundSource: candidate.profile.source,
        ignoreFailedSubs: false,
        persistSnapshot: false,
        // The injected resolver is the side-effect boundary: normal renders
        // retain cache writes and stale fallback, while preflight does neither.
        subscriptionResolver: resolveSubscriptionForPreflight,
      },
    );
    // The single device gate. Every write path in the app already funnels
    // through this function, so extending it here — and ONLY here — means no
    // entry point can mutate the shared layer into a state that breaks a
    // device, and no device patch can be stored without being checked against
    // the exact document it will be applied to. N ≤ 16 in-memory
    // patch+validate rounds over one already-computed render.
    assertDevicePatchesValid(resolved.content, candidate.devices);
  } catch (error) {
    if (
      error instanceof ConfigValidationError ||
      error instanceof ConfigPreflightUnavailableError
    ) {
      throw error;
    }
    // Unknown failures are programming/infrastructure errors, not proof that
    // the user's candidate is invalid. Let the central handler keep them a
    // generic 500 instead of manufacturing a misleading 422.
    throw error;
  }

  return { configVersion: version, candidate };
}

/**
 * Validate every device's patch against the candidate's rendered output.
 *
 * Failures are aggregated so one save reports ALL broken devices rather than
 * making the user fix them one round-trip at a time; the thrown issue names the
 * offending device(s), because "your save was rejected" without a device name
 * is unactionable when the conflict lives in a patch the user isn't looking at.
 */
function assertDevicePatchesValid(sharedContent: string, devices: readonly Device[]): void {
  if (devices.length === 0) return;

  const failures: { name: string; issue: ConfigValidationError }[] = [];
  for (const device of devices) {
    try {
      buildDeviceConfig(sharedContent, device.base_patch, device.name, device.features);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        failures.push({ name: device.name, issue: error });
        continue;
      }
      throw error;
    }
  }
  if (failures.length === 0) return;

  const first = failures[0];
  const others =
    failures.length > 1
      ? `（另有 ${failures.length - 1} 台设备也受影响：${failures
          .slice(1)
          .map((f) => f.name)
          .join('、')}）`
      : '';
  throw new ConfigValidationError({
    code: first.issue.issue.code,
    message: `${first.issue.message}${others} —— 请先修改该设备的差异或设备功能，再保存共享层改动。`,
    section: 'devices',
    path: `devices[${first.name}].${first.issue.issue.path}`,
    resource: 'device',
  });
}

/** Apply id-keyed upserts/deletes without mutating the loaded snapshot. */
export function applyConfigEntityChanges<T extends { id: string }>(
  current: readonly T[],
  writes: readonly T[],
  removes: readonly string[],
): T[] {
  const removed = new Set(removes);
  const writesById = new Map(writes.map((item) => [item.id, item]));
  // The atomic Redis commit applies writes before deletes, so a conflicting
  // id is absent in the persisted result. Mirror that exact delete-wins
  // ordering in the candidate sent to the validator.
  for (const id of removed) writesById.delete(id);
  const out: T[] = [];
  for (const item of current) {
    if (removed.has(item.id)) continue;
    out.push(writesById.get(item.id) ?? item);
    writesById.delete(item.id);
  }
  out.push(...writesById.values());
  return out;
}

async function loadStableProfileState(
  profileId: string,
): Promise<{ version: number; state: ProfileConfigState }> {
  for (let attempt = 0; attempt < SNAPSHOT_READ_ATTEMPTS; attempt += 1) {
    const version = await getConfigVersion();
    const [
      profile,
      base,
      rules,
      subscriptions,
      proxyGroups,
      templates,
      ruleSets,
      collections,
      devices,
    ] = await Promise.all([
      getProfile(profileId),
      getBase(profileId),
      listRules(profileId),
      listSubscriptions(),
      listProxyGroups(profileId),
      listProxyGroupTemplates(),
      listRuleSets(),
      listCollections(),
      listDevices(profileId),
    ]);
    const after = await getConfigVersion();
    if (version !== after) continue;
    if (!profile || !base) {
      throw new ConfigValidationError({
        code: 'profile_config_uninitialized',
        message: 'Configuration validation failed: the profile or base config is missing.',
        section: 'config',
        path: '$',
        resource: 'profile-config',
      });
    }
    return {
      version,
      state: {
        profile,
        baseContent: base.content,
        rules,
        subscriptions,
        proxyGroups,
        templates,
        ruleSets,
        collections,
        devices,
      },
    };
  }
  throw new ConfigPreflightUnavailableError();
}
