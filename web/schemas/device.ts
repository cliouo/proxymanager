import { z } from 'zod';
import { NAME_REGEX, NAME_HINT } from './profile';
import { RuleCreateSchema } from './rule';

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
const FEATURE_NAME_MAX = 128;
const FeatureGeneratedNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(FEATURE_NAME_MAX)
  .regex(/^[^\u0000-\u001f\u007f,]+$/, '名称不能包含逗号或控制字符');
const TailscaleCidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    const parsed = RuleCreateSchema.safeParse({
      anchor: 'device-feature',
      type: value.includes(':') ? 'IP-CIDR6' : 'IP-CIDR',
      value,
      policy: 'Tailscale',
      options: ['no-resolve'],
      source: 'manual',
    });
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: '必须是合法的 IPv4 或 IPv6 CIDR' });
    }
  });

export const TailscaleHostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'hostname 只能含字母、数字和中划线');

const TailscaleControlUrlSchema = z
  .string()
  .trim()
  .url()
  .max(512)
  .superRefine((value, ctx) => {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'controlUrl 只支持 http 或 https' });
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      ctx.addIssue({
        code: 'custom',
        message: 'controlUrl 不能包含账号、密码、查询参数或片段',
      });
    }
  });

/** Persisted device-scoped Tailscale instance. The auth key never leaves server APIs. */
export const TailscaleDeviceFeatureSchema = z
  .object({
    hostname: TailscaleHostnameSchema,
    authKey: z.string().trim().min(1).max(256).regex(/^\S+$/, 'authKey 不能包含空白').optional(),
    controlUrl: TailscaleControlUrlSchema.optional(),
    stateDir: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[^\u0000-\u001f\u007f]+$/, 'stateDir 不能包含控制字符')
      .optional(),
    ephemeral: z.boolean().default(false),
    acceptRoutes: z.boolean().default(true),
    udp: z.boolean().default(true),
    exitNode: z.string().trim().min(1).max(128).optional(),
    exitNodeAllowLanAccess: z.boolean().default(false),
    nodeName: FeatureGeneratedNameSchema.optional(),
    groupName: FeatureGeneratedNameSchema.optional(),
    extraCidrs: z
      .array(TailscaleCidrSchema)
      .max(64)
      .default([])
      .superRefine((values, ctx) => {
        const seen = new Set<string>();
        values.forEach((value, index) => {
          if (seen.has(value)) {
            ctx.addIssue({
              code: 'custom',
              message: '额外 CIDR 不能重复',
              path: [index],
            });
          }
          seen.add(value);
        });
      }),
  })
  .strict();

export type TailscaleDeviceFeature = z.infer<typeof TailscaleDeviceFeatureSchema>;

export const DeviceFeaturesSchema = z
  .object({
    tailscale: TailscaleDeviceFeatureSchema.optional(),
  })
  .strict()
  .default({});

export type DeviceFeatures = z.infer<typeof DeviceFeaturesSchema>;

/** Dedicated write payload. Omitted key means preserve; null explicitly clears it. */
export const TailscaleDeviceFeatureUpdateSchema = TailscaleDeviceFeatureSchema.omit({
  authKey: true,
}).extend({
  authKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^\S+$/, 'authKey 不能包含空白')
    .nullable()
    .optional(),
});

export type TailscaleDeviceFeatureUpdate = z.input<typeof TailscaleDeviceFeatureUpdateSchema>;

export interface PublicTailscaleDeviceFeature extends Omit<TailscaleDeviceFeature, 'authKey'> {
  hasAuthKey: boolean;
}

export interface PublicDeviceFeatures {
  tailscale?: PublicTailscaleDeviceFeature;
}

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
  /**
   * Typed device-only feature instances. They are injected after base_patch at render time.
   * Generic device PATCH does not accept this field; each feature has a dedicated API.
   */
  features: DeviceFeaturesSchema,
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

export function publicDeviceFeatures(features: DeviceFeatures): PublicDeviceFeatures {
  const tailscale = features.tailscale;
  if (!tailscale) return {};
  const safe = { ...tailscale };
  delete safe.authKey;
  return { tailscale: { ...safe, hasAuthKey: Boolean(tailscale.authKey) } };
}
