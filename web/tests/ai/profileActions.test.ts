import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@/schemas';

const PROFILE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEMPLATE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECRET_SUB_URL = 'https://user:password@airport.example/api/token1234567890/sub';

const mocks = vi.hoisted(() => ({
  profiles: [] as Profile[],
  createProfile: vi.fn(),
  patchProfile: vi.fn(),
}));

vi.mock('@/lib/services/profileService', () => ({
  createProfile: mocks.createProfile,
  patchProfile: mocks.patchProfile,
}));
vi.mock('@/lib/repos/profilesRepo', () => ({
  listProfiles: vi.fn(async () => mocks.profiles),
  getProfile: vi.fn(async (id: string) => mocks.profiles.find((p) => p.id === id) ?? null),
  getProfileByName: vi.fn(
    async (name: string) => mocks.profiles.find((p) => p.name === name) ?? null,
  ),
}));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  listSubscriptions: vi.fn(async () => [
    { id: SUB_ID, name: '机场A', kind: 'remote', url: SECRET_SUB_URL },
  ]),
}));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: vi.fn(async () => []) }));

const CTX = { actor: 'test', profileId: PROFILE_ID };

interface TestWriteAction {
  summary(input: Record<string, unknown>): string;
  preview(ctx: typeof CTX, input: Record<string, unknown>): Promise<{ diff: unknown }>;
  execute(ctx: typeof CTX, input: Record<string, unknown>): Promise<unknown>;
}

function requireWriteAction(
  actions: ReadonlyArray<{ name: string }>,
  name: string,
): TestWriteAction {
  const action = actions.find((item) => item.name === name);
  if (!action) throw new Error(`missing ${name}`);
  return action as unknown as TestWriteAction;
}

interface TestReadAction {
  run(ctx: typeof CTX, input: Record<string, unknown>): Promise<{ kind: string; data: unknown }>;
}

function requireReadAction(actions: ReadonlyArray<{ name: string }>, name: string): TestReadAction {
  const action = actions.find((item) => item.name === name);
  if (!action) throw new Error(`missing ${name}`);
  return action as unknown as TestReadAction;
}

beforeEach(() => {
  mocks.createProfile.mockReset();
  mocks.patchProfile.mockReset();
  mocks.profiles = [
    {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'subscription', id: SUB_ID },
      kind: 'normal',
      updated_at: 1,
    },
    {
      id: TEMPLATE_ID,
      name: 'general-template',
      display_name: '通用模版',
      source: { type: 'none' },
      kind: 'template',
      updated_at: 1,
    },
  ];
});

describe('list_profiles', () => {
  it('marks the current scope and labels bindings without leaking URLs', async () => {
    const { PROFILE_READ_ACTIONS } = await import('@/lib/ai/actions/primitives/profileWrites');
    const action = requireReadAction(PROFILE_READ_ACTIONS, 'list_profiles');

    const result = await action.run(CTX, {});
    const data = result.data as { profiles: { name: string; current: boolean; kind: string }[] };
    expect(data.profiles.find((p) => p.name === 'default')?.current).toBe(true);
    expect(data.profiles.find((p) => p.name === 'general-template')?.current).toBe(false);
    expect(data.profiles.find((p) => p.name === 'general-template')?.kind).toBe('template');

    const serialized = JSON.stringify(result.data);
    expect(serialized).toContain('机场A');
    expect(serialized).not.toContain('airport.example');
    expect(serialized).not.toContain('token1234567890');
    expect(serialized).not.toContain('password');
  });
});

describe('create_profile', () => {
  it('clones from a template and labels the source in the preview diff', async () => {
    const { PROFILE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/profileWrites');
    const action = requireWriteAction(PROFILE_WRITE_ACTIONS, 'create_profile');

    const input = { name: 'laptop', kind: 'normal', copy_from: TEMPLATE_ID };
    const preview = await action.preview(CTX, input);
    const serialized = JSON.stringify(preview.diff);
    expect(serialized).toContain('general-template');
    expect(serialized).toContain('模版');

    mocks.createProfile.mockResolvedValue({ id: 'new-id', name: 'laptop', kind: 'normal' });
    await action.execute(CTX, input);
    expect(mocks.createProfile).toHaveBeenCalledWith({
      name: 'laptop',
      kind: 'normal',
      copy_from: TEMPLATE_ID,
    });
  });

  it('fails the preview early on duplicate names and missing clone sources', async () => {
    const { PROFILE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/profileWrites');
    const action = requireWriteAction(PROFILE_WRITE_ACTIONS, 'create_profile');

    await expect(action.preview(CTX, { name: 'default', kind: 'normal' })).rejects.toThrow(
      /已存在/,
    );
    await expect(
      action.preview(CTX, {
        name: 'fresh',
        kind: 'normal',
        copy_from: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).rejects.toThrow(/不存在/);
    expect(mocks.createProfile).not.toHaveBeenCalled();
  });
});

describe('update_profile', () => {
  it('maps source_type/source_id onto the discriminated source union', async () => {
    const { PROFILE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/profileWrites');
    const action = requireWriteAction(PROFILE_WRITE_ACTIONS, 'update_profile');

    mocks.patchProfile.mockResolvedValue(mocks.profiles[1]);
    await action.execute(CTX, {
      id: TEMPLATE_ID,
      source_type: 'subscription',
      source_id: SUB_ID,
    });
    expect(mocks.patchProfile).toHaveBeenCalledWith(TEMPLATE_ID, {
      source: { type: 'subscription', id: SUB_ID },
    });

    await action.execute(CTX, { id: TEMPLATE_ID, source_type: 'none', display_name: null });
    expect(mocks.patchProfile).toHaveBeenLastCalledWith(TEMPLATE_ID, {
      source: { type: 'none' },
      display_name: null,
    });
  });

  it('rejects a source_id without a source_type and a bind without an id', async () => {
    const { PROFILE_WRITE_ACTIONS } = await import('@/lib/ai/actions/primitives/profileWrites');
    const action = requireWriteAction(PROFILE_WRITE_ACTIONS, 'update_profile');

    await expect(action.preview(CTX, { id: TEMPLATE_ID, source_id: SUB_ID })).rejects.toThrow(
      /source_type/,
    );
    await expect(
      action.preview(CTX, { id: TEMPLATE_ID, source_type: 'subscription' }),
    ).rejects.toThrow(/source_id/);
    expect(mocks.patchProfile).not.toHaveBeenCalled();
  });
});
