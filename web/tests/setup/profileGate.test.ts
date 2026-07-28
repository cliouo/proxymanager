import { describe, expect, it } from 'vitest';
import { isProfileScopedPath } from '@/components/nav';
import { deriveProfileScopeAccess } from '@/components/profile/ProfileContext';

describe('profile-scoped mutation gate', () => {
  it.each([
    '/base',
    '/proxy-groups',
    '/proxy-groups/group-id',
    '/rules',
    '/config',
    '/devices',
    '/scenarios/chained-proxy',
    '/profiles/35000000-0000-4000-8000-000000000001',
    '/profiles/35000000-0000-4000-8000-000000000001/devices/device-id',
  ])('classifies %s as profile-scoped', (pathname) => {
    expect(isProfileScopedPath(pathname)).toBe(true);
  });

  it.each(['/', '/profiles', '/subscriptions', '/rule-sets', '/history', '/docs'])(
    'keeps shared route %s outside the profile scope gate',
    (pathname) => {
      expect(isProfileScopedPath(pathname)).toBe(false);
    },
  );

  it('blocks both first-read and cached-list failures', () => {
    expect(
      deriveProfileScopeAccess({
        loading: false,
        loaded: true,
        error: 'network failure',
        hasActiveProfile: false,
      }),
    ).toBe('error');
    expect(
      deriveProfileScopeAccess({
        loading: false,
        loaded: true,
        error: 'network failure',
        hasActiveProfile: true,
      }),
    ).toBe('error');
  });

  it('opens scoped pages only after a successful read confirms an active profile', () => {
    expect(
      deriveProfileScopeAccess({
        loading: true,
        loaded: false,
        error: null,
        hasActiveProfile: true,
      }),
    ).toBe('loading');
    expect(
      deriveProfileScopeAccess({
        loading: false,
        loaded: true,
        error: null,
        hasActiveProfile: false,
      }),
    ).toBe('empty');
    expect(
      deriveProfileScopeAccess({
        loading: false,
        loaded: true,
        error: null,
        hasActiveProfile: true,
      }),
    ).toBe('ready');
  });
});
