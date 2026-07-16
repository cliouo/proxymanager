import { ConfigPreflightUnavailableError, ConfigValidationError } from '@/lib/config/errors';
import { resolveConfig } from '@/lib/engine/resolve';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { getProfile } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import {
  SubscriptionResolutionValidationError,
  SubscriptionUpstreamUnavailableError,
} from '@/lib/services/subscriptionResolutionErrors';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import type { FetchSubscriptionProxiesResult } from '@/lib/services/subscriptionFetcher';
import type {
  Collection,
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
      const issue =
        error.stage === 'operators'
          ? {
              message: 'A subscription operator pipeline is invalid.',
              path: 'subscriptions[].operators',
            }
          : error.stage === 'definition'
            ? {
                message: 'A subscription definition is invalid.',
                path: 'subscriptions[]',
              }
            : {
                message: 'A subscription contains invalid proxy nodes.',
                path: 'subscriptions[].content',
              };
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
    await resolveConfig(
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
    const [profile, base, rules, subscriptions, proxyGroups, templates, ruleSets, collections] =
      await Promise.all([
        getProfile(profileId),
        getBase(profileId),
        listRules(profileId),
        listSubscriptions(),
        listProxyGroups(profileId),
        listProxyGroupTemplates(),
        listRuleSets(),
        listCollections(),
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
      },
    };
  }
  throw new ConfigPreflightUnavailableError();
}
