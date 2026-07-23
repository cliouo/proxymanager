/**
 * 设备 CRUD 编排 —— 每一次写都是同一条流水线：
 *
 *   preflight（含该设备补丁对候选产物的校验）→ config:version CAS 提交 → 审计
 *
 * 三件事都不可省：preflight 是 AGENTS.md 的 save-time invariant（且设备校验就挂在
 * 它里面，见 configPreflight.assertDevicePatchesValid）；CAS 保证「校验过的那份
 * 候选」与「落库的那份状态」是同一代；审计里敏感键一律掩码。
 */

import { ConfigValidationError } from '@/lib/config/errors';
import { redactSensitive, touchesSensitiveKeys } from '@/lib/engine/devicePatch';
import { ProblemDetailsError } from '@/lib/http/problem';
import { recordEvent } from '@/lib/repos/auditRepo';
import {
  commitDeviceChanges,
  getDevice,
  listDevices,
  type DeviceChanges,
} from '@/lib/repos/devicesRepo';
import { getProfile } from '@/lib/repos/profilesRepo';
import type { AuditEventInput } from '@/lib/scenarios/_shared/types';
import { preflightProfileConfig } from '@/lib/services/configPreflight';
import {
  DeviceCreateSchema,
  DeviceUpdateSchema,
  MAX_DEVICES_PER_PROFILE,
  type Device,
  type DeviceCreate,
  type DeviceUpdate,
} from '@/schemas';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function requireProfile(profileId: string): Promise<void> {
  const profile = await getProfile(profileId);
  if (!profile) throw ProblemDetailsError.notFound(`profile ${profileId} 不存在。`);
}

/** 一次设备变更的完整计划，全部从版本括号内的稳定快照推导。 */
interface DevicePlan<T> {
  /** 变更后的完整设备集 —— preflight 校验的就是它。 */
  devices: Device[];
  /** 要落库的写集，必须从上面那份 devices 派生。 */
  changes: DeviceChanges;
  /** 返回给调用方的结果（新建/修改后的记录等）。 */
  outcome: T;
}

/**
 * 设备写入的唯一通道：**在 preflight 的版本括号内**做计划，再 CAS 提交。
 *
 * 为什么计划必须在括号里：同名检查与 16 台上限如果基于括号外单独读的一份列表，
 * 两个并发的创建请求会各自读到「还没有这个名字 / 还只有 15 台」，各自算出一份合法
 * 候选，然后**都**通过 CAS —— 因为 CAS 只保证 config:version 没动，而先提交的那个
 * 会 INCR，后一个直接 412 重试……但重试若仍拿括号外的陈旧列表，就又算出同一份错误
 * 候选。把检查挪进 `preflightProfileConfig` 的候选构造回调，它拿到的是
 * version-bracketed 的稳定快照 `state.devices`，检查、候选、写集三者同源；
 * 412 之后调用方整体重跑本函数，计划连同快照一起重建。
 */
async function mutateDevices<T>(
  profileId: string,
  plan: (current: readonly Device[]) => DevicePlan<T>,
): Promise<T> {
  let planned: DevicePlan<T> | null = null;
  const checked = await preflightProfileConfig(profileId, (state) => {
    // 每次重跑都从这一刻的快照重新计划(preflight 内部若因快照不稳定而重读,
    // 这个回调也会拿到新的 state)。
    planned = plan(state.devices);
    return { devices: planned.devices };
  });
  if (!planned) {
    // preflight 必然调用过回调;这里只是让类型收窄，同时防御未来的改动。
    throw ProblemDetailsError.preconditionFailed('设备变更计划未能生成,请重试。');
  }
  const settled: DevicePlan<T> = planned;

  const result = await commitDeviceChanges(profileId, settled.changes, checked.configVersion);
  if (!result.ok) {
    throw ProblemDetailsError.preconditionFailed(
      '配置在保存前校验期间被其他写入修改,请刷新后重试。',
    );
  }
  return settled.outcome;
}

/** 同名检查 —— 设备名进订阅 URL，同一 profile 内必须唯一。 */
function assertNameFree(devices: readonly Device[], name: string, exceptId?: string): void {
  if (devices.some((d) => d.name === name && d.id !== exceptId)) {
    throw ProblemDetailsError.conflict(`设备名称 "${name}" 在该配置文件下已存在。`);
  }
}

/**
 * 审计快照：敏感键掩码后的补丁。
 *
 * 掩码的代价是这份快照不能用来还原 —— 所以触到敏感键的变更显式标 `undoable:false`，
 * 与 tailscale `update-auth-key` 无 inverse 的既有决策同源：宁可不能撤销，也不能把
 * `***` 当真值写回配置。
 */
function auditSnapshot(device: Device | null): unknown {
  if (!device) return undefined;
  return {
    id: device.id,
    name: device.name,
    display_name: device.display_name,
    notes: device.notes,
    base_patch: redactSensitive(device.base_patch),
  };
}

export async function listProfileDevices(profileId: string): Promise<Device[]> {
  await requireProfile(profileId);
  return listDevices(profileId);
}

export async function getProfileDevice(profileId: string, deviceId: string): Promise<Device> {
  await requireProfile(profileId);
  const device = await getDevice(profileId, deviceId);
  if (!device) throw ProblemDetailsError.notFound(`设备 ${deviceId} 不存在。`);
  return device;
}

export async function createDevice(profileId: string, input: DeviceCreate): Promise<Device> {
  await requireProfile(profileId);
  const parsed = DeviceCreateSchema.parse(input);

  const device = await mutateDevices(profileId, (current) => {
    assertNameFree(current, parsed.name);
    if (current.length >= MAX_DEVICES_PER_PROFILE) {
      throw new ConfigValidationError({
        code: 'device_limit_exceeded',
        message: `每份配置文件最多 ${MAX_DEVICES_PER_PROFILE} 台设备（当前 ${current.length} 台）。`,
        section: 'devices',
        path: 'devices',
        resource: 'device',
      });
    }
    const ts = nowSeconds();
    const created: Device = {
      id: crypto.randomUUID(),
      name: parsed.name,
      ...(parsed.display_name !== undefined ? { display_name: parsed.display_name } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      base_patch: parsed.base_patch,
      created_at: ts,
      updated_at: ts,
    };
    return {
      devices: [...current, created],
      changes: { writes: [created] },
      outcome: created,
    };
  });

  await recordEvent({
    op: 'device.create',
    actor: 'admin',
    target: { kind: 'device', id: device.id, name: device.name },
    after: auditSnapshot(device),
    profileId,
    undoable: !touchesSensitiveKeys(device.base_patch),
  });
  return device;
}

export async function patchDevice(
  profileId: string,
  deviceId: string,
  patch: DeviceUpdate,
): Promise<Device> {
  await requireProfile(profileId);
  const validated = DeviceUpdateSchema.parse(patch);

  let before: Device | null = null;
  const next = await mutateDevices(profileId, (current) => {
    const target = current.find((d) => d.id === deviceId);
    if (!target) throw ProblemDetailsError.notFound(`设备 ${deviceId} 不存在。`);
    if (validated.name && validated.name !== target.name) {
      assertNameFree(current, validated.name, deviceId);
    }

    const updated: Device = { ...target, updated_at: nowSeconds() };
    for (const [key, value] of Object.entries(validated)) {
      if (value === null) {
        delete (updated as Record<string, unknown>)[key];
      } else if (value !== undefined) {
        (updated as Record<string, unknown>)[key] = value;
      }
    }
    before = target;
    return {
      devices: current.map((d) => (d.id === deviceId ? updated : d)),
      changes: { writes: [updated] },
      outcome: updated,
    };
  });

  await recordEvent({
    op: 'device.update',
    actor: 'admin',
    target: { kind: 'device', id: next.id, name: next.name },
    before: auditSnapshot(before),
    after: auditSnapshot(next),
    profileId,
    undoable:
      !touchesSensitiveKeys((before as Device | null)?.base_patch ?? {}) &&
      !touchesSensitiveKeys(next.base_patch),
  });
  return next;
}

/* ─── 撤销 ──────────────────────────────────────────────────────────── */

/** 审计快照 → 完整设备记录（快照不带时间戳，落库时现补）。 */
function deviceFromSnapshot(raw: unknown, now: number): Device {
  const snap = (raw ?? {}) as Partial<Device>;
  if (typeof snap.id !== 'string' || typeof snap.name !== 'string') {
    throw ProblemDetailsError.unprocessable('审计快照缺少设备 id 或名称,无法撤销。');
  }
  return {
    id: snap.id,
    name: snap.name,
    ...(snap.display_name !== undefined ? { display_name: snap.display_name } : {}),
    ...(snap.notes !== undefined ? { notes: snap.notes } : {}),
    base_patch: snap.base_patch ?? {},
    created_at: snap.created_at ?? now,
    updated_at: now,
  };
}

/**
 * 撤销一条设备事件。走的仍是 {@link mutateDevices} —— 同一条 preflight + CAS 通道，
 * 撤销不是特权路径：把配置改回去同样可能与**当下**的共享层冲突（比如期间 base 变了），
 * 那就该照样被拦下。
 *
 * 快照保真是前提：只有 `undoable !== false`（即补丁不含敏感键）的事件会走到这里，
 * 掩码过的快照永远不会被当作真值写回去 —— 与 tailscale `update-auth-key` 无 inverse
 * 的既有决策同源。
 */
export async function undoDeviceEvent(
  profileId: string,
  event: { op: string; before?: unknown; after?: unknown },
): Promise<{ data: unknown; events: AuditEventInput[] }> {
  await requireProfile(profileId);
  const action = event.op.slice(event.op.lastIndexOf('.') + 1);
  const now = nowSeconds();

  if (action === 'create') {
    // 建 → 删。
    const created = deviceFromSnapshot(event.after, now);
    const removed = await mutateDevices(profileId, (current) => {
      const target = current.find((d) => d.id === created.id);
      if (!target) {
        throw ProblemDetailsError.conflict(`设备 ${created.id} 已不存在,无需撤销。`);
      }
      return {
        devices: current.filter((d) => d.id !== created.id),
        changes: { deletes: [created.id] },
        outcome: target,
      };
    });
    return {
      data: null,
      events: [
        {
          action: 'delete',
          target: { kind: 'device', id: removed.id, name: removed.name },
          before: auditSnapshot(removed),
        },
      ],
    };
  }

  if (action === 'update') {
    // 改 → 恢复前一份快照。
    const previous = deviceFromSnapshot(event.before, now);
    const { current, reverted } = await mutateDevices(profileId, (devices) => {
      const target = devices.find((d) => d.id === previous.id);
      if (!target) {
        throw ProblemDetailsError.conflict(`设备 ${previous.id} 已不存在,无法回退。`);
      }
      assertNameFree(devices, previous.name, previous.id);
      return {
        devices: devices.map((d) => (d.id === previous.id ? previous : d)),
        changes: { writes: [previous] },
        outcome: { current: target, reverted: previous },
      };
    });
    return {
      data: reverted,
      events: [
        {
          action: 'update',
          target: { kind: 'device', id: reverted.id, name: reverted.name },
          before: auditSnapshot(current),
          after: auditSnapshot(reverted),
        },
      ],
    };
  }

  if (action === 'delete') {
    // 删 → 按原 id 重建（id 保持不变，历史里的引用与设备详情页链接才对得上）。
    const restored = deviceFromSnapshot(event.before, now);
    await mutateDevices(profileId, (current) => {
      if (current.some((d) => d.id === restored.id)) {
        throw ProblemDetailsError.conflict(`设备 ${restored.id} 已存在,无需恢复。`);
      }
      assertNameFree(current, restored.name);
      if (current.length >= MAX_DEVICES_PER_PROFILE) {
        throw new ConfigValidationError({
          code: 'device_limit_exceeded',
          message: `每份配置文件最多 ${MAX_DEVICES_PER_PROFILE} 台设备,无法恢复。`,
          section: 'devices',
          path: 'devices',
          resource: 'device',
        });
      }
      return {
        devices: [...current, restored],
        changes: { writes: [restored] },
        outcome: restored,
      };
    });
    return {
      data: restored,
      events: [
        {
          action: 'create',
          target: { kind: 'device', id: restored.id, name: restored.name },
          after: auditSnapshot(restored),
        },
      ],
    };
  }

  throw ProblemDetailsError.unprocessable(`设备操作 "${action}" 没有注册撤销路径。`);
}

export async function deleteDevice(profileId: string, deviceId: string): Promise<boolean> {
  await requireProfile(profileId);
  // 「不存在」是 no-op 而不是错误,所以先廉价探一次;真正的存在性判定仍在括号内
  // 重做一遍(下面的 plan),这次只是为了在明显不存在时不白跑一整轮 preflight。
  if (!(await getDevice(profileId, deviceId))) return false;

  let removed: Device | null = null;
  const ok = await mutateDevices(profileId, (current) => {
    const target = current.find((d) => d.id === deviceId);
    if (!target) {
      // 括号内发现已被别人删掉 —— 结果与我们想要的一致,不写不报错。
      return { devices: [...current], changes: {}, outcome: false };
    }
    removed = target;
    return {
      devices: current.filter((d) => d.id !== deviceId),
      changes: { deletes: [deviceId] },
      outcome: true,
    };
  });
  if (!ok || !removed) return false;
  const deleted: Device = removed;

  await recordEvent({
    op: 'device.delete',
    actor: 'admin',
    target: { kind: 'device', id: deleted.id, name: deleted.name },
    before: auditSnapshot(deleted),
    profileId,
    undoable: !touchesSensitiveKeys(deleted.base_patch),
  });
  return true;
}
