/** Stable profileId takes precedence; explicit name is legacy-compatible.
 * A conflicting name/ID, invalid ID or deleted profile never falls back.
 * The cookie/default path remains for older callers that omit explicit scope. */

import { ProblemDetailsError } from '@/lib/http/problem';
import { getProfile, getProfileByName } from '@/lib/repos/profilesRepo';
import { z } from 'zod';
import { DEFAULT_PROFILE_NAME, type Profile } from '@/schemas';

/** Cookie the UI sets to remember the active editing profile. */
export const ACTIVE_PROFILE_COOKIE = 'pm.active_profile';

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * The profile name an authed editing request targets, applying the precedence
 * above. Pure string resolution — no Redis lookup. Callers that need the record
 * should use {@link resolveScopeProfile}.
 */
export function resolveScopeProfileName(request: Request): string {
  const fromQuery = new URL(request.url).searchParams.get('profile');
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();
  const fromCookie = readCookie(request, ACTIVE_PROFILE_COOKIE);
  if (fromCookie && fromCookie.trim()) return fromCookie.trim();
  return DEFAULT_PROFILE_NAME;
}

/**
 * Resolve the active editing {@link Profile} record for an authed request.
 * Throws 404 if the resolved name has no profile record.
 */
export async function resolveScopeProfile(request: Request): Promise<Profile> {
  const params = new URL(request.url).searchParams;
  if (params.has('profileId')) {
    const id = params.get('profileId');
    if (!z.uuid().safeParse(id).success)
      throw ProblemDetailsError.badRequest('profileId 必须是有效的 UUID。');
    const profile = await getProfile(id!);
    if (!profile) throw ProblemDetailsError.notFound('配置文件不存在。');
    if (params.has('profile') && params.get('profile')?.trim() !== profile.name) {
      throw ProblemDetailsError.badRequest('profile 与 profileId 指向不同配置文件。');
    }
    return profile;
  }
  if (params.has('profile') && !params.get('profile')?.trim())
    throw ProblemDetailsError.badRequest('profile 不能为空。');
  const name = resolveScopeProfileName(request);
  const profile = await getProfileByName(name);
  if (!profile) {
    throw ProblemDetailsError.notFound(`配置文件 "${name}" 不存在。`);
  }
  return profile;
}
