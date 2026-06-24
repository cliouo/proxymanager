import { describe, expect, it } from 'vitest';
import { ACTIVE_PROFILE_COOKIE, resolveScopeProfileName } from '@/lib/profileScope';

/**
 * resolveScopeProfileName precedence: `?profile=` query wins, else the
 * `pm.active_profile` cookie, else `default`. Pure string resolution — no Redis.
 */
function req(url: string, cookie?: string): Request {
  return new Request(url, cookie ? { headers: { cookie } } : undefined);
}

describe('resolveScopeProfileName', () => {
  it('defaults to "default" with no query and no cookie', () => {
    expect(resolveScopeProfileName(req('https://x/api/v1/base'))).toBe('default');
  });

  it('uses the cookie when present', () => {
    expect(
      resolveScopeProfileName(req('https://x/api/v1/base', `${ACTIVE_PROFILE_COOKIE}=prod`)),
    ).toBe('prod');
  });

  it('query param wins over the cookie', () => {
    expect(
      resolveScopeProfileName(
        req('https://x/api/v1/base?profile=staging', `${ACTIVE_PROFILE_COOKIE}=prod`),
      ),
    ).toBe('staging');
  });

  it('ignores a blank query param and falls back to the cookie', () => {
    expect(
      resolveScopeProfileName(req('https://x/api/v1/base?profile=', `${ACTIVE_PROFILE_COOKIE}=prod`)),
    ).toBe('prod');
  });

  it('decodes a url-encoded cookie value', () => {
    expect(
      resolveScopeProfileName(req('https://x/api/v1/base', `${ACTIVE_PROFILE_COOKIE}=my%2Dprofile`)),
    ).toBe('my-profile');
  });

  it('picks the right cookie among several', () => {
    expect(
      resolveScopeProfileName(
        req('https://x/api/v1/base', `other=1; ${ACTIVE_PROFILE_COOKIE}=prod; theme=dark`),
      ),
    ).toBe('prod');
  });
});
