import { z } from 'zod';
import { NAME_REGEX, NAME_HINT } from './profile';

/**
 * 设备 (Device) —— 挂在 profile 下的**差量实体**。
 *
 * 心智模型：配置文件是底，每台设备 = 底 + 几张差异贴纸。共享层（base / 策略组 /
 * 规则 / 链式代理）改一次全设备生效；设备只存自己那几项差异，永远跟随共享层。
 *
 * 与「克隆一份 profile」的分界：设备差异只能是**最终渲染产物顶层键**的补丁
 * （端口 / secret / external-ui / find-process-mode 之类）。要改策略组成员或
 * 节点过滤，那实质是另一份配置文件，请克隆 profile —— 不要往设备层塞。
 *
 * 名字进订阅 URL（`/api/sub/{token}/{profile}/{device}`），所以复用 profile 的
 * kebab-case NAME_REGEX；`name` 在同一 profile 内唯一（重复 409）。
 */

/** 每 profile 的设备数上限 —— preflight 要对每台设备跑一次 patch+validate。 */
export const MAX_DEVICES_PER_PROFILE = 16;

/** base_patch 序列化后的字节上限。 */
export const MAX_BASE_PATCH_BYTES = 32 * 1024;

/** base_patch 的最大嵌套深度（顶层对象算第 1 层）。 */
export const MAX_BASE_PATCH_DEPTH = 8;

const DISPLAY_NAME_MAX = 120;

export const DeviceSchema = z.object({
  id: z.uuid(),
  /** kebab-case，进订阅 URL。与 profile 同一套命名约束。 */
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT),
  /** 客户端导入后显示的名字；留空则回退到 `{profile}-{device}`。 */
  display_name: z.string().max(DISPLAY_NAME_MAX).optional(),
  notes: z.string().optional(),
  /**
   * RFC 7386 JSON Merge Patch，作用于**最终渲染配置**的顶层：
   * 对象逐字段深合并；数组/标量整段替换；`null` 删除该键。
   *
   * 静态约束（lib/engine/devicePatch.ts）：必须是对象、管控键黑名单
   * （proxies / proxy-groups / rules / rule-providers 由共享层管理）、尺寸与深度上限。
   */
  base_patch: z.record(z.string(), z.unknown()).default({}),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export type Device = z.infer<typeof DeviceSchema>;

export const DeviceCreateSchema = z.object({
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT),
  display_name: z.string().max(DISPLAY_NAME_MAX).optional(),
  notes: z.string().optional(),
  base_patch: z.record(z.string(), z.unknown()).default({}),
});

export type DeviceCreate = z.input<typeof DeviceCreateSchema>;

export const DeviceUpdateSchema = z.object({
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT).optional(),
  display_name: z.string().max(DISPLAY_NAME_MAX).nullable().optional(),
  notes: z.string().nullable().optional(),
  /** 整份替换（补丁本身就是差量，不做「补丁的补丁」）。 */
  base_patch: z.record(z.string(), z.unknown()).optional(),
});

export type DeviceUpdate = z.infer<typeof DeviceUpdateSchema>;
