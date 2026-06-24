/**
 * Active editing profile resolution for authed routes.
 *
 * Phase 2 made base / rules / proxy-groups owned per profile. The editing
 * routes (`/api/v1/base`, `/proxy-groups`, `/rules`, derived `/anchors`,
 * `/policies`, scenario ops, …) therefore need to know WHICH profile they act
 * on. Precedence:
 *   1. `?profile=<name>` query param (explicit, wins) — what the scoped pages send;
 *   2. the `pm.active_profile` cookie (the sidebar switcher's selection);
 *   3. `default` (the always-present anchor profile).
 *
 * The resolved name is looked up to a real {@link Profile}; an unknown name is
 * a 404 rather than silently falling back, so a stale URL/cookie can't quietly
 * edit the wrong profile.
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { getProfileByName } from '@/lib/repos/profilesRepo';
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
  const name = resolveScopeProfileName(request);
  const profile = await getProfileByName(name);
  if (!profile) {
    throw ProblemDetailsError.notFound(`配置文件 "${name}" 不存在。`);
  }
  return profile;
}
