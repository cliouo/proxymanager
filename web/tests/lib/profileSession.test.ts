import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeNext } from '@/lib/client/safeNext';
import {
  bindProfileSession,
  scopeRequest,
  startProfileSession,
} from '@/lib/client/profile-session';

describe('safe next URL', () => {
  it.each([
    '//evil.test/path',
    '/\\evil.test/path',
    '/%5cevil.test/path',
    '/%255cevil.test',
    '/%2f%2fevil.test',
    '/\nevil.test',
    'https://evil.test',
    'javascript:alert(1)',
  ])('rejects %s', (value) => {
    expect(safeNext(value, 'https://pm.test')).toBe('/');
  });
  it('retains a same-origin path, query and fragment', () => {
    expect(safeNext('/rules?q=example#list', 'https://pm.test')).toBe('/rules?q=example#list');
  });
});

describe('tab profile scope', () => {
  beforeEach(() => startProfileSession());
  it('waits for the first confirmed ID and never reads cookies', async () => {
    const request = scopeRequest('/api/v1/base', 'PUT');
    bindProfileSession('profile-a', true);
    expect(await request).toBe('/api/v1/base?profileId=profile-a');
    vi.stubGlobal('document', { cookie: 'pm.active_profile=other-profile' });
    expect(await scopeRequest('/api/v1/rules?limit=100')).toBe(
      '/api/v1/rules?limit=100&profileId=profile-a',
    );
    vi.unstubAllGlobals();
  });
  it('pauses mutations on refresh failure but retains scoped reads', async () => {
    bindProfileSession('profile-a', false);
    await expect(scopeRequest('/api/v1/base', 'PUT')).rejects.toThrow('尚未确认');
    await expect(scopeRequest('/api/v1/profiles/profile-a', 'PATCH')).rejects.toThrow('尚未确认');
    expect(await scopeRequest('/api/v1/base')).toContain('profileId=profile-a');
  });
  it('never falls back after initial read failure', async () => {
    bindProfileSession(null, false);
    await expect(scopeRequest('/api/v1/base')).rejects.toThrow('没有已确认');
  });
});
