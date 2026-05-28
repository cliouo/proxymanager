import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { ProfileSchema, type Profile } from '@/schemas';

function normalise(raw: unknown): Profile | null {
  const parsed = ProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** All profiles, sorted by `name` for determinism. */
export async function listProfiles(): Promise<Profile[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(REDIS_KEYS.profiles);
  if (!all) return [];
  const out: Profile[] = [];
  for (const raw of Object.values(all)) {
    const p = normalise(raw);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProfile(id: string): Promise<Profile | null> {
  const raw = await getRedis().hget<unknown>(REDIS_KEYS.profiles, id);
  return normalise(raw);
}

/** Look up a profile by its kebab-case name (preview route uses this). */
export async function getProfileByName(name: string): Promise<Profile | null> {
  const all = await listProfiles();
  return all.find((p) => p.name === name) ?? null;
}

export async function upsertProfile(profile: Profile): Promise<void> {
  await getRedis().hset(REDIS_KEYS.profiles, { [profile.id]: profile });
}

export async function deleteProfile(id: string): Promise<boolean> {
  const removed = await getRedis().hdel(REDIS_KEYS.profiles, id);
  return removed > 0;
}
