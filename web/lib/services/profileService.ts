import { ProblemDetailsError } from '@/lib/http/problem';
import {
  deleteProfile as repoDelete,
  getProfile,
  getProfileByName,
  listProfiles,
  upsertProfile,
} from '@/lib/repos/profilesRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import {
  ProfileCreateSchema,
  ProfileUpdateSchema,
  type Profile,
  type ProfileCreate,
  type ProfileUpdate,
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
 * Confirm every subscription_id refers to a real sub. Wrong ids would render
 * to nothing at resolve time — silently surprising — so reject up front.
 */
async function assertSubscriptionIdsExist(ids: string[] | undefined): Promise<void> {
  if (!ids || ids.length === 0) return;
  const subs = await listSubscriptions();
  const known = new Set(subs.map((s) => s.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw ProblemDetailsError.unprocessable(
      `subscription_ids 中包含未知订阅源: ${missing.join(', ')}`,
    );
  }
}

export async function createProfile(input: ProfileCreate): Promise<Profile> {
  const parsed = ProfileCreateSchema.parse(input);
  const dup = await getProfileByName(parsed.name);
  if (dup) {
    throw ProblemDetailsError.conflict(`profile 名称 "${parsed.name}" 已存在。`);
  }
  await assertSubscriptionIdsExist(parsed.subscription_ids);
  const now = nowSeconds();
  const profile: Profile = {
    ...parsed,
    id: generateProfileId(),
    created_at: now,
    updated_at: now,
  } as Profile;
  await upsertProfile(profile);
  invalidateSnapshot();
  return profile;
}

/**
 * Patch a profile. `null` on a nullable optional field clears it (notes).
 * Any change to `subscription_ids` invalidates the resolved snapshot so the
 * next preview reflects the new binding.
 */
export async function patchProfile(id: string, patch: ProfileUpdate): Promise<Profile> {
  const validated = ProfileUpdateSchema.parse(patch);
  const current = await getProfile(id);
  if (!current) {
    throw ProblemDetailsError.notFound(`profile ${id} 不存在。`);
  }
  if (validated.name && validated.name !== current.name) {
    const dup = await getProfileByName(validated.name);
    if (dup && dup.id !== id) {
      throw ProblemDetailsError.conflict(`profile 名称 "${validated.name}" 已存在。`);
    }
  }
  if (validated.subscription_ids !== undefined) {
    await assertSubscriptionIdsExist(validated.subscription_ids);
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
  // Phase 1 guard: don't let the user nuke the single "default" profile via
  // the API; preview lookups would fall back to "all enabled" which is
  // probably unintended in a setup where bindings were deliberate.
  const all = await listProfiles();
  if (all.length <= 1) {
    throw ProblemDetailsError.conflict('至少保留一个 profile;无法删除最后一个。');
  }
  const removed = await repoDelete(id);
  if (removed) invalidateSnapshot();
  return removed;
}

export { listProfiles, getProfile, getProfileByName };
