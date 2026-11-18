import { z } from '@/lib/openapi/zod';
import { canonicalIpLiteral, ipLiteralFamily } from '@/lib/net/ipLiteral';
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

/**
 * One exact `IP + port` destination routed to a Tailscale instance.
 *
 * Service routes exist so a device can pick *which* embedded Tailscale handles
 * a named service instead of sending the whole tailnet range to one node. The
 * address must be a literal (hostnames would need resolver-dependent routing
 * and mihomo evaluates these rules before any DNS answer exists).
 */
export const TailscaleServiceRouteSchema = z
  .object({
    ip: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .superRefine((value, ctx) => {
        if (ipLiteralFamily(value) === 0) {
          ctx.addIssue({ code: 'custom', message: '必须是合法的 IPv4 或 IPv6 地址' });
        }
      }),
    port: z.number().int().min(0).max(65_535),
  })
  .strict();

export type TailscaleServiceRoute = z.infer<typeof TailscaleServiceRouteSchema>;

/**
 * Comparison key for a service route: the canonical IP spelling plus the port.
 * `2001:DB8::1` and `2001:db8:0:0:0:0:0:1` are the same destination, so two
 * instances must not both claim them.
 */
export function tailscaleServiceRouteKey(route: { ip: string; port: number }): string {
  const canonical = canonicalIpLiteral(route.ip) || route.ip.trim().toLowerCase();
  return `${canonical}#${route.port}`;
}

/**
 * Routing mode of one instance.
 *
 * - `cidr` — historical behaviour: the tailnet CIDR (`100.64.0.0/10`) plus any
 *   extra CIDRs. Only the legacy slot may use it, and it can never be combined
 *   with `serviceRoutes`.
 * - `service` — only the explicitly listed `IP + port` pairs. Additional
 *   instances always use this mode.
 */
export const TailscaleRouteModeSchema = z.enum(['cidr', 'service']);

export type TailscaleRouteMode = z.infer<typeof TailscaleRouteModeSchema>;

/**
 * Shape of one persisted instance, before the cross-field routing checks.
 *
 * Kept separate because the update payload is derived with `.omit()` (zod
 * refuses `.omit()` on a refined object) and because a service-mode route list
 * may legitimately be *preserved* by a legacy PUT that omits it.
 */
const TailscaleDeviceFeatureShape = z
  .object({
    id: z.uuid().optional(),
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
    /**
     * Explicit routing mode. Absent means the historical broad-tailnet mode
     * (the legacy slot) or service mode (any additional instance).
     */
    routeMode: TailscaleRouteModeSchema.optional(),
    /**
     * Exact `IP + port` services routed to this instance. Only the legacy slot
     * may switch to `cidr` mode; additional instances must carry at least one.
     */
    serviceRoutes: z.array(TailscaleServiceRouteSchema).max(64).optional(),
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

/** Persisted device-scoped Tailscale instance. The auth key never leaves server APIs. */
export const TailscaleDeviceFeatureSchema = TailscaleDeviceFeatureShape.superRefine(
  (feature, ctx) => {
    const routes = feature.serviceRoutes ?? [];
    if (feature.routeMode === 'service') {
      if (routes.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['serviceRoutes'],
          message: '服务模式的实例至少要配置一条「目标 IP + 端口」',
        });
      }
      if (feature.extraCidrs.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['extraCidrs'],
          message: '服务模式与额外 CIDR 互斥；要按网段分流请显式切回 CIDR 模式',
        });
      }
    } else if (routes.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['serviceRoutes'],
        message: 'CIDR 模式的实例不能同时携带服务路由；请先显式切换到服务模式',
      });
    }
    const seen = new Set<string>();
    routes.forEach((route, index) => {
      const key = tailscaleServiceRouteKey(route);
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['serviceRoutes', index],
          message: '同一实例内不能重复配置同一个「目标 IP + 端口」',
        });
      }
      seen.add(key);
    });
  },
);

export type TailscaleDeviceFeature = z.infer<typeof TailscaleDeviceFeatureSchema>;

/** Max total Tailscale instances per device, the legacy slot included. */
export const MAX_TAILSCALE_INSTANCES_PER_DEVICE = 8;

export const DeviceFeaturesSchema = z
  .object({
    /** The original slot. Legacy callers keep operating exactly this entry. */
    tailscale: TailscaleDeviceFeatureSchema.optional(),
    /**
     * Additional instances, keyed by a server-generated immutable id. The
     * legacy slot never lives here, so deleting the legacy instance cannot
     * promote anything and removing an additional instance cannot repoint
     * legacy callers.
     */
    tailscaleInstances: z.array(TailscaleDeviceFeatureSchema).max(15).optional(),
  })
  .strict()
  .default({})
  .superRefine((features, ctx) => {
    const legacy = features.tailscale;
    if (legacy?.routeMode === 'service' && (legacy.serviceRoutes ?? []).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tailscale', 'serviceRoutes'],
        message: '服务模式的实例至少要配置一条「目标 IP + 端口」',
      });
    }

    const instances = features.tailscaleInstances ?? [];
    if (instances.length === 0) return;
    if ((legacy ? 1 : 0) + instances.length > MAX_TAILSCALE_INSTANCES_PER_DEVICE) {
      ctx.addIssue({
        code: 'custom',
        path: ['tailscaleInstances'],
        message: `每台设备最多 ${MAX_TAILSCALE_INSTANCES_PER_DEVICE} 个 Tailscale 实例`,
      });
    }
    const seenIds = new Set<string>();
    instances.forEach((instance, index) => {
      if (!instance.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['tailscaleInstances', index, 'id'],
          message: '附加实例必须携带服务端生成的稳定 id',
        });
        return;
      }
      if (seenIds.has(instance.id) || instance.id === legacy?.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['tailscaleInstances', index, 'id'],
          message: '附加实例 id 不能重复，也不能与原实例相同',
        });
      }
      seenIds.add(instance.id);
      if (instance.routeMode !== 'service') {
        ctx.addIssue({
          code: 'custom',
          path: ['tailscaleInstances', index, 'routeMode'],
          message: '附加实例只能使用服务模式（显式「目标 IP + 端口」）',
        });
      }
    });
  });

export type DeviceFeatures = z.infer<typeof DeviceFeaturesSchema>;

/** Dedicated write payload. Omitted key means preserve; null explicitly clears it. */
export const TailscaleDeviceFeatureUpdateSchema = TailscaleDeviceFeatureShape.omit({
  authKey: true,
  id: true,
  routeMode: true,
  serviceRoutes: true,
}).extend({
  authKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^\S+$/, 'authKey 不能包含空白')
    .nullable()
    .optional(),
  /**
   * Omitted = preserve the stored routing (and therefore the stored auth key
   * semantics). `null` on the legacy slot explicitly returns it to CIDR mode;
   * additional instances reject `null` because they cannot fall back to a
   * broad route. `[]` is rejected: switching modes must be explicit, so an
   * empty list can never quietly widen routing back to the whole /10.
   */
  serviceRoutes: z.array(TailscaleServiceRouteSchema).min(1).max(64).nullable().optional(),
});

export type TailscaleDeviceFeatureUpdate = z.input<typeof TailscaleDeviceFeatureUpdateSchema>;

/**
 * Create/update payload for an *additional* instance (never the legacy slot).
 * `routeMode` may only be spelled as `service`; it is forced on the server.
 */
export const TailscaleInstanceCreateSchema = TailscaleDeviceFeatureUpdateSchema.extend({
  routeMode: z.literal('service').optional(),
  serviceRoutes: z.array(TailscaleServiceRouteSchema).min(1).max(64),
  /** Service mode and extra CIDRs are mutually exclusive. */
  extraCidrs: z.array(TailscaleCidrSchema).max(0).optional(),
});

export type TailscaleInstanceCreate = z.input<typeof TailscaleInstanceCreateSchema>;

/**
 * PATCH-like update for one additional instance: every field is optional and
 * **no default is filled in**, so an omitted boolean keeps its stored value
 * instead of silently resetting to the schema default.
 */
export const TailscaleInstanceUpdateSchema = z
  .object({
    hostname: TailscaleHostnameSchema.optional(),
    authKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^\S+$/, 'authKey 不能包含空白')
      .nullable()
      .optional(),
    controlUrl: TailscaleControlUrlSchema.optional(),
    stateDir: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[^\u0000-\u001f\u007f]+$/, 'stateDir 不能包含控制字符')
      .optional(),
    ephemeral: z.boolean().optional(),
    acceptRoutes: z.boolean().optional(),
    udp: z.boolean().optional(),
    exitNode: z.string().trim().min(1).max(128).optional(),
    exitNodeAllowLanAccess: z.boolean().optional(),
    nodeName: FeatureGeneratedNameSchema.optional(),
    groupName: FeatureGeneratedNameSchema.optional(),
    routeMode: z.literal('service').optional(),
    serviceRoutes: z.array(TailscaleServiceRouteSchema).min(1).max(64).optional(),
    /** Service mode and extra CIDRs are mutually exclusive. */
    extraCidrs: z.array(TailscaleCidrSchema).max(0).optional(),
  })
  .strict();

export type TailscaleInstanceUpdate = z.input<typeof TailscaleInstanceUpdateSchema>;

export interface PublicTailscaleDeviceFeature extends Omit<TailscaleDeviceFeature, 'authKey'> {
  hasAuthKey: boolean;
}

export interface PublicDeviceFeatures {
  tailscale?: PublicTailscaleDeviceFeature;
  tailscaleInstances?: PublicTailscaleDeviceFeature[];
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
  const instances = features.tailscaleInstances ?? [];
  const out: PublicDeviceFeatures = {};
  if (tailscale) out.tailscale = publicFeature(tailscale);
  if (instances.length > 0) out.tailscaleInstances = instances.map(publicFeature);
  return out;
}

function publicFeature(feature: TailscaleDeviceFeature): PublicTailscaleDeviceFeature {
  const safe = { ...feature };
  delete safe.authKey;
  return { ...safe, hasAuthKey: Boolean(feature.authKey) };
}
