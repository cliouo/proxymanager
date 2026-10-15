/**
 * Fresh profile/device rendering. Only subscription bodies are cached.
 * The module path and response status fields are retained for callers; legacy
 * render:* entries are neither read nor written and expire naturally.
 */

import { deriveSubToken } from '@/lib/auth';
import { createHash } from 'node:crypto';
import { buildDeviceConfig } from '@/lib/engine/devicePatch';
import { resolveConfig, type ResolveResult } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getDeviceByName } from '@/lib/repos/devicesRepo';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';

const REPAIR_INVALID_CONFIG_VERSION = `
local current = redis.call('GET', KEYS[1])
local canonical = current == '0' or (current and string.match(current, '^[1-9]%d*$'))
if canonical then
  local parsed = tonumber(current)
  if parsed and parsed <= 9007199254740991 then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`.trim();

export type CachedResolveOutput = Pick<
  ResolveResult,
  | 'content'
  | 'buildId'
  | 'anchorsApplied'
  | 'unmatchedAnchors'
  | 'ruleProvidersApplied'
  | 'subscriptions'
  | 'collisions'
  | 'nodeNames'
  | 'nodesBySub'
  | 'warnings'
  | 'inlinedProxyCount'
  | 'proxyGroupCount'
>;

export type RenderCacheStatus = 'miss' | 'bypass';

export interface RenderProfileOptions {
  /** Identity already authenticated by the route; names can change owners. */
  expectedProfileId?: string;
  providerUrlBase?: string;
  /** Force upstream refresh; ordinary renders still use subscription caches. */
  noCache?: boolean;
  /** Public distribution records fetch health; previews opt out. */
  recordFetchHealth?: boolean;
  missingBaseError?: () => ProblemDetailsError;
}

export interface RenderProfileResult {
  resolved: CachedResolveOutput;
  baseEtag: string;
  baseUpdatedAt: number;
  displayName: string | null;
  renderedAt: number;
  /** Compatibility header: miss for ordinary rendering, bypass for noCache. */
  cache: RenderCacheStatus;
}

export interface RenderDeviceResult extends RenderProfileResult {
  deviceDisplayName: string | null;
  sharedCache: RenderCacheStatus;
}

const RENDER_SNAPSHOT_ATTEMPTS = 3;

function readConfigVersion(value: unknown): number | null {
  if (value === null) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Repair corrupt generations without overwriting a concurrent valid INCR. */
async function captureVersion(): Promise<number> {
  const redis = getRedis();
  let version = readConfigVersion(await redis.get<unknown>(REDIS_KEYS.configVersion));
  if (version === null) {
    await redis.eval(
      REPAIR_INVALID_CONFIG_VERSION,
      [REDIS_KEYS.configVersion],
      [String(Date.now())],
    );
    version = readConfigVersion(await redis.get<unknown>(REDIS_KEYS.configVersion));
  }
  if (version === null) throw ProblemDetailsError.preconditionFailed('配置版本无效，请稍后重试。');
  return version;
}

async function versionIsCurrent(version: number): Promise<boolean> {
  return readConfigVersion(await getRedis().get<unknown>(REDIS_KEYS.configVersion)) === version;
}

function defaultMissingBaseError(): ProblemDetailsError {
  return ProblemDetailsError.notFound('Base config has not been initialized yet.');
}

export async function renderProfileConfig(
  profileName: string,
  opts: RenderProfileOptions = {},
): Promise<RenderProfileResult> {
  for (let attempt = 0; attempt < RENDER_SNAPSHOT_ATTEMPTS; attempt++) {
    const version = await captureVersion();
    const result = await renderProfileSnapshot(profileName, opts, version);
    if (await versionIsCurrent(version)) return result;
  }
  throw ProblemDetailsError.preconditionFailed('配置正在更新，请稍后重试。');
}

/** Caller owns the version bracket, including device reads when applicable. */
async function renderProfileSnapshot(
  profileName: string,
  opts: RenderProfileOptions,
  version: number,
): Promise<RenderProfileResult> {
  const profileRecord = await getProfileByName(profileName);
  if (!profileRecord) {
    if (profileName === 'default') {
      throw (opts.missingBaseError ?? defaultMissingBaseError)();
    }
    throw ProblemDetailsError.notFound(`Profile "${profileName}" 不存在。`);
  }

  if (opts.expectedProfileId !== undefined && profileRecord.id !== opts.expectedProfileId) {
    throw ProblemDetailsError.notFound('Profile identity changed during the request.');
  }

  const [base, rules, providers, subscriptions, proxyGroups, templates, collections] =
    await Promise.all([
      getBase(profileRecord.id),
      listRules(profileRecord.id),
      listRuleSets(),
      listSubscriptions(),
      listProxyGroups(profileRecord.id),
      listProxyGroupTemplates(),
      listCollections(),
    ]);
  if (!base) {
    throw (opts.missingBaseError ?? defaultMissingBaseError)();
  }

  const resolved = await resolveConfig(base.content, rules, subscriptions, proxyGroups, templates, {
    providers,
    providerUrlBase: opts.providerUrlBase,
    providerUrl: opts.providerUrlBase
      ? (provider) => {
          const origin = new URL(opts.providerUrlBase!).origin;
          const token = deriveSubToken({
            type: 'rule-set',
            id: provider.id,
            tokenVersion: provider.token_version,
          });
          return `${origin}/api/rule-providers/${token}/${encodeURIComponent(provider.name)}`;
        }
      : undefined,
    // Keep the existing source failure policy and final-config validation.
    ignoreFailedSubs: false,
    noCache: opts.noCache,
    // P-FFP v1: health is recorded only by real serving attempts; preview/
    // preflight callers disable it at this boundary.
    recordFetchHealth: opts.recordFetchHealth !== false,
    collections,
    // Profile binding — which subscription(s) this profile injects.
    boundSource: profileRecord.source,
    // Bind serving ordinal writes to the generation captured before any
    // config record was loaded. A superseded render then cannot publish.
    ordinalConfigVersion: version,
    // Key the resolved-snapshot by this profile so concurrent renders of other
    // profiles don't overwrite its node list (P2-5).
    snapshotProfileId: profileRecord.id,
  });

  return {
    resolved,
    baseEtag: base.etag,
    baseUpdatedAt: base.updated_at,
    displayName: profileRecord.display_name ?? null,
    cache: opts.noCache ? 'bypass' : 'miss',
    renderedAt: Date.now(),
  };
}

/** One version bracket covers both shared config and the device patch. */
export async function renderDeviceConfig(
  profileName: string,
  deviceName: string,
  opts: RenderProfileOptions = {},
): Promise<RenderDeviceResult> {
  for (let attempt = 0; attempt < RENDER_SNAPSHOT_ATTEMPTS; attempt++) {
    // Read the generation before any profile/device/config records.
    const version = await captureVersion();
    const profile = await getProfileByName(profileName);
    if (!profile) throw ProblemDetailsError.notFound(`Profile "${profileName}" 不存在。`);
    if (opts.expectedProfileId !== undefined && profile.id !== opts.expectedProfileId) {
      throw ProblemDetailsError.notFound('Profile identity changed during the request.');
    }
    const device = await getDeviceByName(profile.id, deviceName);
    if (!device) throw ProblemDetailsError.notFound(`设备 "${deviceName}" 不存在。`);

    const shared = await renderProfileSnapshot(
      profileName,
      {
        ...opts,
        expectedProfileId: profile.id,
      },
      version,
    );
    const content = buildDeviceConfig(
      shared.resolved.content,
      device.base_patch,
      device.name,
      device.features,
    );
    if (!(await versionIsCurrent(version))) continue;

    return {
      ...shared,
      resolved: {
        ...shared.resolved,
        content,
        // Each device's actual content determines its ETag.
        buildId: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8),
      },
      deviceDisplayName: device.display_name ?? null,
      sharedCache: shared.cache,
    };
  }
  throw ProblemDetailsError.preconditionFailed('配置正在更新，请稍后重试。');
}
