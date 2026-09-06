import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getProfile: vi.fn(), getProfileByName: vi.fn() }));
vi.mock('@/lib/repos/profilesRepo', () => mocks);
import { resolveScopeProfile } from '@/lib/profileScope';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProfile.mockResolvedValue({ id, name: 'renamed' });
});
it('uses stable ID despite another tab changing the cookie', async () => {
  expect(
    await resolveScopeProfile(
      new Request(`https://pm.test/api/v1/base?profileId=${id}`, {
        headers: { cookie: 'pm.active_profile=other' },
      }),
    ),
  ).toMatchObject({ id });
  expect(mocks.getProfileByName).not.toHaveBeenCalled();
});
it.each(['profileId=', 'profileId=bad', `profileId=${id}&profile=other`, 'profile='])(
  'rejects invalid/conflicting scope: %s',
  async (query) => {
    await expect(
      resolveScopeProfile(new Request(`https://pm.test/api/v1/base?${query}`)),
    ).rejects.toMatchObject({ problem: { status: 400 } });
    expect(mocks.getProfileByName).not.toHaveBeenCalled();
  },
);
it('does not fall back when the pinned ID was deleted', async () => {
  mocks.getProfile.mockResolvedValue(null);
  await expect(
    resolveScopeProfile(new Request(`https://pm.test/api/v1/base?profileId=${id}`)),
  ).rejects.toMatchObject({ problem: { status: 404 } });
  expect(mocks.getProfileByName).not.toHaveBeenCalled();
});
