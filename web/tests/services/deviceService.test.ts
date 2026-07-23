/**
 * 设备 CRUD 的编排契约：preflight → CAS 提交 → 审计，一步都不能少。
 *
 * 这里的 preflight 替身会**真的调用候选构造回调**，并传入一份可由测试单独控制的
 * 「版本括号内快照」。这样才测得到本轮修复的核心：同名 / 上限检查必须基于括号内的
 * 快照，而不是括号外那份可能已经过期的列表。
 *
 * 另外盯住两件容易在重构里悄悄丢掉的事：
 *   - 提交用的版本号必须是 **preflight 返回的那个**；
 *   - 触到敏感键的变更 `undoable:false`，且审计快照里的值是 `***`。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '@/schemas';

const mocks = vi.hoisted(() => ({
  preflightProfileConfig: vi.fn(),
  commitDeviceChanges: vi.fn(),
  listDevices: vi.fn(),
  getDevice: vi.fn(),
  getProfile: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: mocks.preflightProfileConfig,
}));
vi.mock('@/lib/repos/devicesRepo', () => ({
  commitDeviceChanges: mocks.commitDeviceChanges,
  listDevices: mocks.listDevices,
  getDevice: mocks.getDevice,
}));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfile: mocks.getProfile }));
vi.mock('@/lib/repos/auditRepo', () => ({ recordEvent: mocks.recordEvent }));

import { ProblemDetailsError } from '@/lib/http/problem';
import { ConfigValidationError } from '@/lib/config/errors';
import {
  createDevice,
  deleteDevice,
  patchDevice,
  undoDeviceEvent,
} from '@/lib/services/deviceService';
import { MAX_DEVICES_PER_PROFILE } from '@/schemas';

const PROFILE_ID = 'p-1';

function device(over: Partial<Device> = {}): Device {
  return {
    id: crypto.randomUUID(),
    name: 'macbook',
    base_patch: {},
    created_at: 1,
    updated_at: 1,
    ...over,
  } as Device;
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ProblemDetailsError ? error.problem.status : undefined;
}

/** 版本括号**内**的稳定快照 —— 权威的那一份。 */
let bracketDevices: Device[] = [];
/** 候选构造回调返回的 patch，供断言「校验的是什么」。 */
let lastCandidateDevices: Device[] | null = null;

/**
 * 让括号外与括号内看到不同的设备列表 —— 模拟「读完列表后、preflight 之前，
 * 另一个写者提交了」。
 */
function setBracketSnapshot(inside: Device[], outsideStale: Device[] = inside): void {
  bracketDevices = inside;
  mocks.listDevices.mockResolvedValue(outsideStale);
}

describe('deviceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bracketDevices = [];
    lastCandidateDevices = null;
    mocks.getProfile.mockResolvedValue({ id: PROFILE_ID, name: 'home' });
    mocks.listDevices.mockResolvedValue([]);
    mocks.getDevice.mockResolvedValue(null);
    mocks.preflightProfileConfig.mockImplementation(
      async (_profileId: string, build: (s: { devices: Device[] }) => { devices: Device[] }) => {
        const state = { devices: bracketDevices };
        const patch = await build(state);
        lastCandidateDevices = patch.devices;
        return { configVersion: 42, candidate: { ...state, ...patch } };
      },
    );
    mocks.commitDeviceChanges.mockResolvedValue({ ok: true, currentVersion: 43 });
    mocks.recordEvent.mockResolvedValue(undefined);
  });

  it('creates through preflight and commits at the preflighted version', async () => {
    const created = await createDevice(PROFILE_ID, {
      name: 'macbook',
      base_patch: { 'mixed-port': 7891 },
    });

    expect(lastCandidateDevices?.map((d) => d.name)).toEqual(['macbook']);
    expect(mocks.commitDeviceChanges).toHaveBeenCalledWith(PROFILE_ID, { writes: [created] }, 42);
  });

  /* ─── 并发回归：检查必须基于括号内快照 ───────────────────────────── */

  it('409s a duplicate name that only the BRACKETED snapshot knows about', async () => {
    // 括号外读到的是空列表（陈旧），括号内的真相是已经有 macbook 了。
    setBracketSnapshot([device({ name: 'macbook' })], []);

    const error = await createDevice(PROFILE_ID, { name: 'macbook' }).catch((e: unknown) => e);

    expect(statusOf(error)).toBe(409);
    expect(mocks.commitDeviceChanges).not.toHaveBeenCalled();
  });

  it('refuses to exceed the cap when only the BRACKETED snapshot is full', async () => {
    setBracketSnapshot(
      Array.from({ length: MAX_DEVICES_PER_PROFILE }, (_, i) => device({ name: `d${i}` })),
      [],
    );

    await expect(createDevice(PROFILE_ID, { name: 'one-too-many' })).rejects.toThrow(
      new RegExp(String(MAX_DEVICES_PER_PROFILE)),
    );
    expect(mocks.commitDeviceChanges).not.toHaveBeenCalled();
  });

  it('derives the write set from the bracketed snapshot, not the stale list', async () => {
    const inside = [device({ name: 'existing' })];
    setBracketSnapshot(inside, []); // 括号外以为一台都没有

    await createDevice(PROFILE_ID, { name: 'newbie' });

    // 候选必须是 括号内的既有设备 + 新设备，而不是「只有新设备」——
    // 后者会让 preflight 漏校验 existing，也让 16 台上限形同虚设。
    expect(lastCandidateDevices?.map((d) => d.name)).toEqual(['existing', 'newbie']);
  });

  it('409s a rename onto a name only the bracketed snapshot has', async () => {
    const target = device({ name: 'a' });
    setBracketSnapshot([target, device({ name: 'b' })], [target]);

    const error = await patchDevice(PROFILE_ID, target.id, { name: 'b' }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe(409);
  });

  it('404s a patch for a device the bracketed snapshot no longer has', async () => {
    const ghost = device({ name: 'gone' });
    setBracketSnapshot([], [ghost]); // 括号外还看得到，括号内已被并发删除

    const error = await patchDevice(PROFILE_ID, ghost.id, { notes: 'x' }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe(404);
    expect(mocks.commitDeviceChanges).not.toHaveBeenCalled();
  });

  it('treats a concurrent delete as a no-op instead of writing a phantom delete', async () => {
    const ghost = device({ name: 'gone' });
    mocks.getDevice.mockResolvedValue(ghost); // 廉价预检时还在
    setBracketSnapshot([], [ghost]); // 括号内已经没了

    await expect(deleteDevice(PROFILE_ID, ghost.id)).resolves.toBe(false);
    expect(mocks.commitDeviceChanges).toHaveBeenCalledWith(PROFILE_ID, {}, 42);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  /* ─── 其余编排契约 ───────────────────────────────────────────────── */

  it('turns a lost CAS race into 412 rather than an unvalidated write', async () => {
    mocks.commitDeviceChanges.mockResolvedValue({ ok: false, currentVersion: 99 });
    const error = await createDevice(PROFILE_ID, { name: 'macbook' }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe(412);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('404s when the profile does not exist', async () => {
    mocks.getProfile.mockResolvedValue(null);
    const error = await createDevice(PROFILE_ID, { name: 'x' }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe(404);
  });

  it('masks sensitive values in the audit snapshot and marks the event un-undoable', async () => {
    await createDevice(PROFILE_ID, { name: 'server', base_patch: { secret: 'real-key' } });

    const event = mocks.recordEvent.mock.calls[0][0];
    expect(event.op).toBe('device.create');
    expect(event.target).toMatchObject({ kind: 'device', name: 'server' });
    expect(event.after.base_patch).toEqual({ secret: '***' });
    expect(event.undoable).toBe(false);
  });

  it('keeps a non-sensitive change undoable with a faithful snapshot', async () => {
    await createDevice(PROFILE_ID, { name: 'phone', base_patch: { 'find-process-mode': 'off' } });
    const event = mocks.recordEvent.mock.calls[0][0];
    expect(event.after.base_patch).toEqual({ 'find-process-mode': 'off' });
    expect(event.undoable).toBe(true);
  });

  it('patches an existing device and preflights the UPDATED candidate', async () => {
    const current = device({ name: 'macbook', base_patch: { 'mixed-port': 1 } });
    setBracketSnapshot([current]);

    const next = await patchDevice(PROFILE_ID, current.id, { base_patch: { 'mixed-port': 2 } });

    expect(next.base_patch).toEqual({ 'mixed-port': 2 });
    expect(lastCandidateDevices?.[0].base_patch).toEqual({ 'mixed-port': 2 });
    expect(mocks.recordEvent.mock.calls[0][0].before.base_patch).toEqual({ 'mixed-port': 1 });
  });

  it('clears a nullable field on null', async () => {
    const current = device({ name: 'macbook', notes: 'old' });
    setBracketSnapshot([current]);
    const next = await patchDevice(PROFILE_ID, current.id, { notes: null });
    expect(next.notes).toBeUndefined();
  });

  it('deletes through preflight with the device removed from the candidate', async () => {
    const current = device({ name: 'macbook' });
    mocks.getDevice.mockResolvedValue(current);
    setBracketSnapshot([current]);

    await expect(deleteDevice(PROFILE_ID, current.id)).resolves.toBe(true);

    expect(lastCandidateDevices).toEqual([]);
    expect(mocks.commitDeviceChanges).toHaveBeenCalledWith(
      PROFILE_ID,
      { deletes: [current.id] },
      42,
    );
    expect(mocks.recordEvent.mock.calls[0][0].op).toBe('device.delete');
  });

  it('deleting an unknown device is a no-op, not an error', async () => {
    await expect(deleteDevice(PROFILE_ID, 'ghost')).resolves.toBe(false);
    expect(mocks.commitDeviceChanges).not.toHaveBeenCalled();
  });
});

/* ─── 撤销 ──────────────────────────────────────────────────────────── */

describe('undoDeviceEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bracketDevices = [];
    lastCandidateDevices = null;
    mocks.getProfile.mockResolvedValue({ id: PROFILE_ID, name: 'home' });
    mocks.listDevices.mockResolvedValue([]);
    mocks.preflightProfileConfig.mockImplementation(
      async (_profileId: string, build: (s: { devices: Device[] }) => { devices: Device[] }) => {
        const state = { devices: bracketDevices };
        const patch = await build(state);
        lastCandidateDevices = patch.devices;
        return { configVersion: 42, candidate: { ...state, ...patch } };
      },
    );
    mocks.commitDeviceChanges.mockResolvedValue({ ok: true, currentVersion: 43 });
  });

  const snapshot = (d: Device) => ({
    id: d.id,
    name: d.name,
    display_name: d.display_name,
    notes: d.notes,
    base_patch: d.base_patch,
  });

  it('undoes a create by deleting the device', async () => {
    const created = device({ name: 'macbook' });
    setBracketSnapshot([created]);

    const out = await undoDeviceEvent(PROFILE_ID, {
      op: 'device.create',
      after: snapshot(created),
    });

    expect(lastCandidateDevices).toEqual([]);
    expect(mocks.commitDeviceChanges).toHaveBeenCalledWith(
      PROFILE_ID,
      { deletes: [created.id] },
      42,
    );
    expect(out.events[0]).toMatchObject({ action: 'delete', target: { kind: 'device' } });
  });

  it('undoes an update by restoring the before-snapshot', async () => {
    const current = device({ name: 'macbook', base_patch: { 'mixed-port': 2 } });
    setBracketSnapshot([current]);

    const out = await undoDeviceEvent(PROFILE_ID, {
      op: 'device.update',
      before: { ...snapshot(current), base_patch: { 'mixed-port': 1 } },
      after: snapshot(current),
    });

    expect(lastCandidateDevices?.[0].base_patch).toEqual({ 'mixed-port': 1 });
    expect(out.events[0]).toMatchObject({ action: 'update' });
  });

  it('undoes a delete by recreating the device WITH ITS ORIGINAL ID', async () => {
    const removed = device({ name: 'macbook', base_patch: { 'external-ui': 'ui' } });
    setBracketSnapshot([]);

    await undoDeviceEvent(PROFILE_ID, { op: 'device.delete', before: snapshot(removed) });

    // id 必须保持 —— 否则历史里的引用与设备详情页链接全部指向一个不存在的 id。
    expect(lastCandidateDevices?.[0].id).toBe(removed.id);
    expect(lastCandidateDevices?.[0].base_patch).toEqual({ 'external-ui': 'ui' });
  });

  it('goes through preflight, so an undo that breaks the config is blocked too', async () => {
    const removed = device({ name: 'macbook' });
    setBracketSnapshot([]);
    mocks.preflightProfileConfig.mockRejectedValue(
      new ConfigValidationError({
        code: 'device_patch_final_invalid',
        message: 'boom',
        section: 'devices',
        path: 'base_patch',
        resource: 'device-patch',
      }),
    );

    await expect(
      undoDeviceEvent(PROFILE_ID, { op: 'device.delete', before: snapshot(removed) }),
    ).rejects.toThrow(/boom/);
    expect(mocks.commitDeviceChanges).not.toHaveBeenCalled();
  });

  it('409s when the thing to undo has already moved on', async () => {
    const created = device({ name: 'macbook' });
    setBracketSnapshot([]); // 已经被别人删了
    const error = await undoDeviceEvent(PROFILE_ID, {
      op: 'device.create',
      after: snapshot(created),
    }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe(409);
  });

  it('409s restoring a delete when the name got taken meanwhile', async () => {
    const removed = device({ name: 'macbook' });
    setBracketSnapshot([device({ name: 'macbook' })]);
    const error = await undoDeviceEvent(PROFILE_ID, {
      op: 'device.delete',
      before: snapshot(removed),
    }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe(409);
  });

  it('422s a snapshot too damaged to restore from', async () => {
    const error = await undoDeviceEvent(PROFILE_ID, {
      op: 'device.delete',
      before: { name: 'no-id' },
    }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe(422);
  });
});
