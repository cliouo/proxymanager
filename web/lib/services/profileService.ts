import { ProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import {
  deleteProfile as repoDelete,
  getProfile,
  getProfileByName,
  listProfiles,
  upsertProfile,
} from '@/lib/repos/profilesRepo';
import { getBase, setBase } from '@/lib/repos/baseRepo';
import { upsertRules, listRules } from '@/lib/repos/rulesRepo';
import { listProxyGroups, upsertProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { createTaxonomyStore } from '@/lib/scenarios/_shared/GroupTaxonomy';
import {
  DEFAULT_PROFILE_NAME,
  ProfileCreateSchema,
  ProfileUpdateSchema,
  type Profile,
  type ProfileCreate,
  type ProfileSource,
  type ProfileUpdate,
  type ProxyGroup,
  type Rule,
} from '@/schemas';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Fire-and-forget snapshot invalidation. See subscriptionService for rationale. */
function invalidateSnapshot(): void {
  invalidateResolvedSnapshot().catch(() => undefined);
}

export function generateProfileId(): string {
  return crypto.randomUUID();
}

/**
 * Confirm a `source` binding points at something that exists. A dangling id
 * would resolve to nothing — silently surprising — so reject up front. `none`
 * (unbound) needs no check.
 */
async function assertSourceValid(source: ProfileSource | undefined): Promise<void> {
  if (!source || source.type === 'none') return;
  if (source.type === 'subscription') {
    const subs = await listSubscriptions();
    if (!subs.some((s) => s.id === source.id)) {
      throw ProblemDetailsError.unprocessable(`绑定的订阅源不存在: ${source.id}`);
    }
    return;
  }
  // collection
  const collections = await listCollections();
  if (!collections.some((c) => c.id === source.id)) {
    throw ProblemDetailsError.unprocessable(`绑定的聚合订阅不存在: ${source.id}`);
  }
}

/**
 * Deep-copy a profile's owned config (base [+ proxy-groups + rules + taxonomy])
 * into a freshly created profile's scope. Proxy-groups and rules get NEW ids;
 * names/rank/section/template_id/bound_* are preserved verbatim, so every
 * cross-reference (group→group, rule→group all by name; template_id→shared
 * template) stays valid without remapping. `includeGroupsRules:false` copies
 * only the base skeleton (the "blank" path — fresh chassis, no routing).
 */
async function cloneProfileConfig(
  srcId: string,
  destId: string,
  includeGroupsRules: boolean,
): Promise<void> {
  const now = nowSeconds();
  const srcBase = await getBase(srcId);
  if (srcBase) {
    // Same content ⇒ same content-hash etag; carry anchors/policies forward.
    await setBase(
      destId,
      srcBase.content,
      {
        etag: srcBase.etag,
        anchors: srcBase.anchors,
        policies: srcBase.policies,
        updated_at: now,
      },
      null,
    );
  }
  if (!includeGroupsRules) return;

  const [groups, rules] = await Promise.all([listProxyGroups(srcId), listRules(srcId)]);
  if (groups.length > 0) {
    const cloned: ProxyGroup[] = groups.map((g) => ({
      ...g,
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    }));
    await upsertProxyGroups(destId, cloned);
  }
  if (rules.length > 0) {
    const cloned: Rule[] = rules.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
      updated_at: now,
    }));
    await upsertRules(destId, cloned);
  }
  // Taxonomy is keyed by group name (preserved on clone), so a straight copy
  // into the new profile's hash is correct.
  const srcTax = await createTaxonomyStore(srcId).all();
  const destTax = createTaxonomyStore(destId);
  for (const [name, tag] of Object.entries(srcTax)) {
    await destTax.set(name, tag);
  }
}

export async function createProfile(input: ProfileCreate): Promise<Profile> {
  const parsed = ProfileCreateSchema.parse(input);
  const dup = await getProfileByName(parsed.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`profile 名称 "${parsed.name}" 已存在。`);
  }
  await assertSourceValid(parsed.source);

  // Resolve the clone source BEFORE creating the record so a bad copy_from
  // fails cleanly. copy_from set → full clone of that profile; omitted → fresh
  // skeleton from `default` (base only, no groups/rules).
  const { copy_from, ...profileFields } = parsed;
  let srcId: string | null = null;
  let includeGroupsRules = false;
  if (copy_from) {
    const src = await getProfile(copy_from);
    if (!src) throw ProblemDetailsError.unprocessable(`复制来源配置文件不存在: ${copy_from}`);
    srcId = src.id;
    includeGroupsRules = true;
  } else {
    const fallback = await getProfileByName(DEFAULT_PROFILE_NAME);
    srcId = fallback?.id ?? null; // null = nothing to seed from (pre-init)
  }

  const now = nowSeconds();
  const profile: Profile = {
    ...profileFields,
    id: generateProfileId(),
    created_at: now,
    updated_at: now,
  } as Profile;
  await upsertProfile(profile);
  if (srcId) {
    // P3-20: if the config clone fails mid-way, we'd otherwise leave a profile
    // record with no base — it resolves to a 404 "uninitialised" state the user
    // can't fix. Roll the record (and any partial owned config) back so a failed
    // create leaves no half-baked profile behind.
    try {
      await cloneProfileConfig(srcId, profile.id, includeGroupsRules);
    } catch (err) {
      await repoDelete(profile.id).catch(() => undefined);
      await getRedis()
        .multi()
        .del(REDIS_KEYS.base.content(profile.id))
        .del(REDIS_KEYS.base.meta(profile.id))
        .del(REDIS_KEYS.rules(profile.id))
        .del(REDIS_KEYS.proxyGroups(profile.id))
        .del(REDIS_KEYS.taxonomy.groups(profile.id))
        .exec()
        .catch(() => undefined);
      throw err;
    }
  }
  invalidateSnapshot();
  return profile;
}

/**
 * Patch a profile. `null` on a nullable optional field clears it (notes).
 * Any change to `source` invalidates the resolved snapshot so the next preview
 * reflects the new binding.
 */
export async function patchProfile(id: string, patch: ProfileUpdate): Promise<Profile> {
  const validated = ProfileUpdateSchema.parse(patch);
  const current = await getProfile(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`profile ${id} 不存在。`);
  }
  if (validated.name && validated.name !== current.name) {
    // P1-1: the `default` profile is the always-present anchor — the scope
    // resolver and unbound-new-profile seed both look it up BY NAME, so renaming
    // it silently breaks those. Guard by the current record's name (the previous
    // guard checked the wrong object / count).
    if (current.name === DEFAULT_PROFILE_NAME) {
      throw ProblemDetailsError.conflict(
        `「${DEFAULT_PROFILE_NAME}」是默认配置文件,不能改名(作用域解析与新建种子都按此名查找)。`,
      );
    }
    const dup = await getProfileByName(validated.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`profile 名称 "${validated.name}" 已存在。`);
    }
  }
  if (validated.source !== undefined) {
    await assertSourceValid(validated.source);
  }

  const next: Profile = { ...current, updated_at: nowSeconds() };
  for (const [k, v] of Object.entries(validated)) {
    if (v === null) {
      delete (next as Record<string, unknown>)[k];
    } else if (v !== undefined) {
      (next as Record<string, unknown>)[k] = v;
    }
  }

  await upsertProfile(next);
  invalidateSnapshot();
  return next;
}

export async function deleteProfile(id: string): Promise<boolean> {
  const current = await getProfile(id);
  if (!current) return false;
  // P1-1: never delete the `default` profile — it's the anchor the scope
  // resolver, the public /api/sub redirect and unbound-new-profile seeding all
  // depend on. (The old guard only blocked deleting the LAST profile, which let
  // `default` be deleted whenever ≥2 existed.)
  if (current.name === DEFAULT_PROFILE_NAME) {
    throw ProblemDetailsError.conflict(
      `「${DEFAULT_PROFILE_NAME}」是默认配置文件,不能删除。`,
    );
  }
  const all = await listProfiles();
  if (all.length <= 1) {
    throw ProblemDetailsError.conflict('至少保留一个 profile;无法删除最后一个。');
  }
  const removed = await repoDelete(id);
  if (removed) {
    // Drop the profile's owned config so its keys don't linger as orphans.
    await getRedis()
      .multi()
      .del(REDIS_KEYS.base.content(id))
      .del(REDIS_KEYS.base.meta(id))
      .del(REDIS_KEYS.rules(id))
      .del(REDIS_KEYS.proxyGroups(id))
      .del(REDIS_KEYS.taxonomy.groups(id))
      .exec();
    invalidateSnapshot();
  }
  return removed;
}

export { listProfiles, getProfile, getProfileByName };
