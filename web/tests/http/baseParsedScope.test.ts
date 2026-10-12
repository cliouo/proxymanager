import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getProfileByName: vi.fn(),
  renderProfileConfig: vi.fn(),
}));
vi.mock('@/lib/repos/profilesRepo', () => mocks);
vi.mock('@/lib/engine/renderCache', () => mocks);
vi.mock('@/lib/engine/structured', () => ({ extractStructured: () => ({}) }));
import { GET } from '@/app/api/v1/base/parsed/route';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProfile.mockResolvedValue({ id, name: 'pinned' });
  mocks.getProfileByName.mockResolvedValue({ name: 'other' });
  mocks.renderProfileConfig.mockResolvedValue({ resolved: { content: 'proxies: []' } });
});
it('honors tab ID despite a conflicting cookie', async () => {
  const response = await GET(
    new Request(`https://pm.test/api/v1/base/parsed?profileId=${id}`, {
      headers: { cookie: 'pm.active_profile=other' },
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.renderProfileConfig.mock.calls[0][0]).toBe('pinned');
});
it.each(['profileId=bad', `profileId=${id}&profile=other`])(
  'rejects invalid scope %s',
  async (query) => {
    const response = await GET(new Request(`https://pm.test/api/v1/base/parsed?${query}`));
    expect(response.status).toBe(400);
    expect(mocks.renderProfileConfig).not.toHaveBeenCalled();
  },
);
it('rejects a deleted pinned profile', async () => {
  mocks.getProfile.mockResolvedValue(null);
  expect(
    (await GET(new Request(`https://pm.test/api/v1/base/parsed?profileId=${id}`))).status,
  ).toBe(404);
  expect(mocks.renderProfileConfig).not.toHaveBeenCalled();
});
