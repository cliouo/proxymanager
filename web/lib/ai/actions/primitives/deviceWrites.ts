/**
 * Device actions — reads plus gated writes over the per-profile device layer
 * ("设备"：共享渲染 + RFC 7386 差量补丁 + 类型化设备级功能).
 *
 * All mutations go through `deviceService` — the same service the /devices UI
 * uses — so every write inherits the full pipeline: version-bracketed plan →
 * `preflightProfileConfig` gate (patch validated against the candidate
 * rendered config) → config-version CAS commit → redacted audit. These
 * actions NEVER touch `commitDeviceChanges`/`buildDeviceConfig` as a write
 * path themselves.
 *
 * Secret discipline (the device layer carries two kinds):
 *  - `base_patch` may contain `secret`/`password`/… — every envelope/diff runs
 *    it through `redactSensitive`, and inputs containing the `***` placeholder
 *    are rejected so a masked read is never written back as a literal.
 *  - The Tailscale `authKey` never leaves the server: envelopes/diffs only
 *    carry the `hasAuthKey` projection (`publicDevice`/`publicDeviceFeatures`).
 *
 * The headline pairing mirrors the proxy-group spoke: `preview_device_config`
 * test-renders a candidate patch against the real shared render BEFORE
 * `create_device`/`update_device` proposes it.
 */

import { z } from 'zod';
import { stringify } from 'yaml';
import { fullRedactedYaml } from '@/lib/ai/configAccess';
import { ConfigValidationError } from '@/lib/config/errors';
import { buildDeviceConfig, redactSensitive } from '@/lib/engine/devicePatch';
import { renderProfileConfig } from '@/lib/engine/renderCache';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getProfile } from '@/lib/repos/profilesRepo';
import {
  createDevice,
  deleteDevice as svcDeleteDevice,
  deleteDeviceTailscaleFeature,
  getProfileDevice,
  listProfileDevices,
  patchDevice,
  publicDevice,
  putDeviceTailscaleFeature,
} from '@/lib/services/deviceService';
import {
  MAX_DEVICES_PER_PROFILE,
  NAME_HINT,
  NAME_REGEX,
  publicDeviceFeatures,
  TailscaleDeviceFeatureUpdateSchema,
  type Device,
  type TailscaleDeviceFeatureUpdate,
} from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

function writeResult(op: string, summary: string, data: unknown): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events: [] } };
}

/**
 * A `***` seen by the model is a redaction placeholder, never a real value —
 * writing it back would persist the mask as the literal secret. Reject early
 * (before any confirmation is minted) with a recoverable explanation.
 */
function assertNoRedactedPlaceholder(value: unknown, what: string): void {
  const touched = (v: unknown): boolean => {
    if (typeof v === 'string') return v.includes('***');
    if (Array.isArray(v)) return v.some(touched);
    if (v && typeof v === 'object') return Object.values(v).some(touched);
    return false;
  };
  if (touched(value)) {
    throw ProblemDetailsError.unprocessable(
      `${what}里含有脱敏占位符 ***（读取结果中的掩码值），不能原样写回。请去掉该键，或让用户在界面中填写真实值。`,
    );
  }
}

/**
 * Resolve `***` placeholders in a candidate patch against the stored patch.
 *
 * `update_device` replaces the patch wholesale, but the model can only ever
 * see masked secrets — without this, the natural "read patch → tweak one key
 * → write the whole thing back" round-trip would either persist the literal
 * `***` or silently drop the secret. So an exact `***` at a path means "keep
 * the stored value here" (same spirit as the Tailscale auth_key omit=keep
 * tri-state). A placeholder with no stored counterpart, or a partially
 * masked string (e.g. a redacted URL), is unresolvable and rejected.
 */
function resolveRedactedPlaceholders(
  candidate: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const resolve = (cand: unknown, stor: unknown, path: string): unknown => {
    if (typeof cand === 'string') {
      if (cand === '***') {
        if (stor !== undefined && !(typeof stor === 'string' && stor.includes('***'))) return stor;
        throw ProblemDetailsError.unprocessable(
          `补丁 ${path} 处的 *** 占位符在该设备存量补丁里没有对应真实值，无法还原。请传真实值，或去掉该键。`,
        );
      }
      if (cand.includes('***')) {
        throw ProblemDetailsError.unprocessable(
          `补丁 ${path} 含部分脱敏的值（内嵌 ***），不能原样写回。请传完整真实值。`,
        );
      }
      return cand;
    }
    if (Array.isArray(cand)) {
      return cand.map((v, i) =>
        resolve(v, Array.isArray(stor) ? stor[i] : undefined, `${path}[${i}]`),
      );
    }
    if (cand && typeof cand === 'object') {
      const storedObj =
        stor && typeof stor === 'object' && !Array.isArray(stor)
          ? (stor as Record<string, unknown>)
          : {};
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cand)) out[k] = resolve(v, storedObj[k], `${path}.${k}`);
      return out;
    }
    return cand;
  };
  return resolve(candidate, stored, 'base_patch') as Record<string, unknown>;
}

/** Compact, redacted YAML view of a device's editable fields for diffs. */
function deviceYaml(view: {
  name?: string;
  display_name?: string;
  notes?: string;
  base_patch?: Record<string, unknown>;
}): string {
  const obj: Record<string, unknown> = { name: view.name };
  if (view.display_name !== undefined) obj.display_name = view.display_name;
  if (view.notes !== undefined) obj.notes = view.notes;
  obj.base_patch = redactSensitive(view.base_patch ?? {});
  return stringify(obj).trimEnd();
}

async function mustGetDevice(profileId: string, deviceId: string): Promise<Device> {
  // deviceService already 404s on a missing device; this wrapper only narrows
  // the id-vs-name confusion in error text for the model.
  return getProfileDevice(profileId, deviceId);
}

const BASE_PATCH_INPUT = z
  .record(z.string(), z.unknown())
  .describe(
    'RFC 7386 JSON Merge Patch，作用于最终渲染配置的顶层键（端口/secret/external-ui/find-process-mode…）：对象逐字段深合并、数组和标量整段替换、null 删键。禁碰 proxies/proxy-groups/rules/rule-providers/proxy-providers（共享层管理）',
  );

/* ─── list_devices ──────────────────────────────────────────────────── */

const listDevices = defineAction({
  name: 'list_devices',
  description:
    '列出当前配置文件下的全部设备（共享渲染 + 每台差量补丁模型）：id、name（进设备订阅 URL）、display_name、notes、base_patch（敏感键已脱敏）、features（Tailscale 只含 hasAuthKey，authKey 永不返回）。任何设备相关操作前先调用拿 id 与现状。只读。',
  input: z.object({}),
  risk: 'read',
  async run(ctx) {
    const devices = (await listProfileDevices(ctx.profileId)).map(publicDevice);
    return {
      kind: 'device-list',
      data: {
        count: devices.length,
        limit: MAX_DEVICES_PER_PROFILE,
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name,
          display_name: d.display_name ?? null,
          notes: d.notes ?? null,
          base_patch: redactSensitive(d.base_patch),
          features: d.features,
          created_at: d.created_at,
          updated_at: d.updated_at,
        })),
      },
    };
  },
});

/* ─── preview_device_config ─────────────────────────────────────────── */

const PreviewDeviceInput = z
  .object({
    device_id: z
      .uuid()
      .optional()
      .describe('已有设备 id（先用 list_devices 拿）；默认用它已存的补丁与 Tailscale 功能试渲染'),
    base_patch: BASE_PATCH_INPUT.optional().describe(
      '候选补丁；给了就代替该设备现有补丁试渲染（新建设备前也可只传它不传 device_id）',
    ),
    include_yaml: z
      .boolean()
      .default(false)
      .describe('true 时返回该设备的最终渲染 YAML（已脱敏，可能较大）；默认只返回校验结果'),
  })
  .refine((v) => v.device_id || v.base_patch, {
    message: '至少给 device_id 或 base_patch 之一',
  });

const previewDeviceConfig = defineAction({
  name: 'preview_device_config',
  description:
    '把一份设备补丁对真实共享渲染试算——校验 RFC 7386 合并、管控键黑名单、尺寸/深度上限与最终配置合法性，补丁非法时返回结构化 issues 而不是报错。改 base_patch 或新建设备前必调；可传已有设备 id（默认用它现有补丁）、也可传候选 base_patch 覆盖对比。只读，不改配置。',
  input: PreviewDeviceInput,
  risk: 'read',
  async run(ctx, input) {
    const profile = await getProfile(ctx.profileId);
    if (!profile) throw ProblemDetailsError.unprocessable('当前配置文件不存在。');
    const device = input.device_id ? await mustGetDevice(ctx.profileId, input.device_id) : null;
    let patch = device?.base_patch ?? {};
    if (input.base_patch) {
      // Candidate patches may round-trip masked reads: resolve `***` against
      // the stored patch when a device is given, otherwise nothing can back
      // the placeholder and it must be rejected.
      if (device) patch = resolveRedactedPlaceholders(input.base_patch, device.base_patch);
      else {
        assertNoRedactedPlaceholder(input.base_patch, '候选补丁');
        patch = input.base_patch;
      }
    }

    const { resolved } = await renderProfileConfig(profile.name, {
      missingBaseError: () => ProblemDetailsError.unprocessable('base.yaml 尚未初始化。'),
    });

    let deviceYamlText: string | null = null;
    const issues: ConfigValidationError['issue'][] = [];
    try {
      deviceYamlText = buildDeviceConfig(
        resolved.content,
        patch,
        device?.name ?? 'candidate',
        device?.features,
      );
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) throw error;
      issues.push(error.issue);
    }

    return {
      kind: 'device-preview',
      data: {
        device: device?.name ?? null,
        base_patch: redactSensitive(patch),
        valid: deviceYamlText !== null,
        issues,
        yaml:
          input.include_yaml && deviceYamlText !== null ? fullRedactedYaml(deviceYamlText) : null,
      },
    };
  },
});

/* ─── create_device ─────────────────────────────────────────────────── */

const CreateDeviceInput = z.object({
  name: z
    .string()
    .min(1)
    .regex(NAME_REGEX, NAME_HINT)
    .describe(
      'kebab-case 标识，进设备订阅 URL（/api/sub/{token}/{profile}/{device}），profile 内唯一',
    ),
  display_name: z
    .string()
    .max(120)
    .optional()
    .describe('客户端导入后的显示名；留空回退 {profile 显示名}-{device}'),
  notes: z.string().optional().describe('备注'),
  base_patch: BASE_PATCH_INPUT.optional(),
});

const createDeviceAction = defineWriteAction({
  name: 'create_device',
  description:
    '在当前配置文件下新建一台设备（共享渲染 + 差量补丁，上限 16 台）。需用户确认。补丁只能改最终渲染的顶层键——要按设备改策略组成员/节点过滤，那实质是另一份配置文件，应克隆 profile 而不是塞设备补丁。写前先用 preview_device_config 试算候选补丁。',
  input: CreateDeviceInput,
  risk: 'write',
  summary: (i) => `新建设备：${i.name}`,
  async preview(_ctx, input) {
    if (input.base_patch) assertNoRedactedPlaceholder(input.base_patch, '补丁');
    return {
      diff: { op: 'add', path: `devices[${input.name}]`, afterYaml: deviceYaml(input) },
    };
  },
  async execute(ctx, input) {
    const created = await createDevice(ctx.profileId, {
      name: input.name,
      ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      base_patch: input.base_patch ?? {},
    });
    return writeResult('add', `已新建设备 ${created.name}`, { id: created.id, name: created.name });
  },
});

/* ─── update_device ─────────────────────────────────────────────────── */

const UpdateDeviceInput = z
  .object({
    id: z.uuid().describe('设备 id（先用 list_devices 拿）'),
    name: z
      .string()
      .min(1)
      .regex(NAME_REGEX, NAME_HINT)
      .optional()
      .describe('改名——设备订阅 URL 含名字，改名会使客户端已导入的旧链接失效，改前先提醒用户'),
    display_name: z.string().max(120).nullable().optional().describe('传 null 清除'),
    notes: z.string().nullable().optional().describe('传 null 清除'),
    base_patch: BASE_PATCH_INPUT.optional().describe(
      '整份替换该设备现有补丁（补丁本身就是差量，不做「补丁的补丁」）；要清空差异传 {}。读取时被掩码为 *** 的敏感值原样带回即保留存量真实值',
    ),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'id' && v[k as keyof typeof v] !== undefined), {
    message: '至少要改一个字段',
  });

const updateDeviceAction = defineWriteAction({
  name: 'update_device',
  description:
    '修改一台设备：改名 / display_name / notes / 整份替换 base_patch（不是增量合并——先 list_devices 拿现有补丁，改好后整份传回；Tailscale 功能不在此改，用 set_device_tailscale）。需用户确认。改 base_patch 前先 preview_device_config 试算。',
  input: UpdateDeviceInput,
  risk: 'write',
  summary: (i) => `修改设备 ${i.id.slice(0, 8)}…`,
  async preview(ctx, input) {
    const before = await mustGetDevice(ctx.profileId, input.id);
    const patch = input.base_patch
      ? resolveRedactedPlaceholders(input.base_patch, before.base_patch)
      : undefined;
    const after = {
      name: input.name ?? before.name,
      display_name:
        input.display_name === null ? undefined : (input.display_name ?? before.display_name),
      notes: input.notes === null ? undefined : (input.notes ?? before.notes),
      base_patch: patch ?? before.base_patch,
    };
    return {
      diff: {
        op: 'update',
        path: `devices[${before.name}]`,
        beforeYaml: deviceYaml(before),
        afterYaml: deviceYaml(after),
      },
    };
  },
  async execute(ctx, input) {
    const { id, ...patch } = input;
    const before = await mustGetDevice(ctx.profileId, id);
    if (patch.base_patch) {
      // Re-resolve against the *current* stored patch — execute may run long
      // after preview, and the service's own preflight+CAS still guards the
      // actual write.
      patch.base_patch = resolveRedactedPlaceholders(patch.base_patch, before.base_patch);
    }
    const updated = await patchDevice(ctx.profileId, id, patch);
    return writeResult('update', `已修改设备 ${before.name}`, {
      id: updated.id,
      name: updated.name,
    });
  },
});

/* ─── delete_device ─────────────────────────────────────────────────── */

const DeleteDeviceInput = z.object({
  id: z.uuid().describe('设备 id（先用 list_devices 拿）'),
});

const deleteDeviceAction = defineWriteAction({
  name: 'delete_device',
  description:
    '删除一台设备。需用户确认。该设备的订阅链接随之失效（已导入它的客户端会拉取失败），其差量补丁与 Tailscale 设备身份一并删除；共享层不受影响。',
  input: DeleteDeviceInput,
  risk: 'write',
  summary: (i) => `删除设备 ${i.id.slice(0, 8)}…`,
  async preview(ctx, input) {
    const before = await mustGetDevice(ctx.profileId, input.id);
    return {
      diff: { op: 'delete', path: `devices[${before.name}]`, beforeYaml: deviceYaml(before) },
    };
  },
  async execute(ctx, input) {
    const before = await mustGetDevice(ctx.profileId, input.id);
    const removed = await svcDeleteDevice(ctx.profileId, input.id);
    if (!removed) throw ProblemDetailsError.notFound(`设备 ${input.id} 不存在。`);
    return writeResult('delete', `已删除设备 ${before.name}`, { name: before.name });
  },
});

/* ─── set_device_tailscale ──────────────────────────────────────────── */

const TailscaleInput = z.object({
  device_id: z.uuid().describe('设备 id（先用 list_devices 拿）'),
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .describe(
      'tailnet 内主机名（字母/数字/中划线）；同一 profile 内 control_url+hostname 不可重复',
    ),
  auth_key: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .nullable()
    .optional()
    .describe(
      'Tailscale auth key（tskey-…）。三态：省略=保留已存 key / null=清除 / 传值=替换。服务端只回 hasAuthKey，永不回显 key 本身',
    ),
  control_url: z
    .string()
    .trim()
    .max(512)
    .optional()
    .describe('自建控制面(headscale)URL；省略用官方'),
  state_dir: z.string().trim().min(1).max(256).optional().describe('状态目录'),
  ephemeral: z.boolean().optional().describe('临时节点；默认 false'),
  accept_routes: z.boolean().optional().describe('接受 tailnet 通告的子网路由；默认 true'),
  udp: z.boolean().optional().describe('默认 true'),
  exit_node: z.string().trim().min(1).max(128).optional().describe('以某 tailnet 节点作出口'),
  exit_node_allow_lan_access: z.boolean().optional().describe('默认 false'),
  node_name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe('注入的 tailscale 节点名；默认自动生成'),
  group_name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe('注入的单成员 select 组名；默认自动生成'),
  extra_cidrs: z
    .array(z.string().trim().min(1).max(64))
    .max(64)
    .optional()
    .describe('除 tailnet 网段 100.64.0.0/10 外还要走 Tailscale 的额外 IPv4/IPv6 CIDR'),
});

/** snake_case tool input → camelCase typed feature payload (authKey三态保留). */
function toFeaturePayload(input: z.infer<typeof TailscaleInput>): TailscaleDeviceFeatureUpdate {
  const payload: Record<string, unknown> = { hostname: input.hostname };
  if (input.auth_key !== undefined) payload.authKey = input.auth_key;
  if (input.control_url !== undefined) payload.controlUrl = input.control_url;
  if (input.state_dir !== undefined) payload.stateDir = input.state_dir;
  if (input.ephemeral !== undefined) payload.ephemeral = input.ephemeral;
  if (input.accept_routes !== undefined) payload.acceptRoutes = input.accept_routes;
  if (input.udp !== undefined) payload.udp = input.udp;
  if (input.exit_node !== undefined) payload.exitNode = input.exit_node;
  if (input.exit_node_allow_lan_access !== undefined)
    payload.exitNodeAllowLanAccess = input.exit_node_allow_lan_access;
  if (input.node_name !== undefined) payload.nodeName = input.node_name;
  if (input.group_name !== undefined) payload.groupName = input.group_name;
  if (input.extra_cidrs !== undefined) payload.extraCidrs = input.extra_cidrs;
  return payload as TailscaleDeviceFeatureUpdate;
}

const setDeviceTailscale = defineWriteAction({
  name: 'set_device_tailscale',
  description:
    '启用或整份更新一台设备的设备级 Tailscale（渲染时注入 tailscale 出站节点 + 单成员 select 组，并把 tailnet CIDR 规则置于规则最前）。需用户确认。整份替换语义：只改一项也要带上要保留的其它字段（先 list_devices 看现状）；唯一例外是 auth_key——省略即保留已存 key。模版 profile 不存 Tailscale 身份，会被拒。',
  input: TailscaleInput,
  risk: 'write',
  summary: (i) => `配置设备 ${i.device_id.slice(0, 8)}… 的 Tailscale（${i.hostname}）`,
  async preview(ctx, input) {
    const device = await mustGetDevice(ctx.profileId, input.device_id);
    const before = publicDeviceFeatures(device.features).tailscale ?? null;

    const { authKey, ...featureFields } = toFeaturePayload(input) as Record<string, unknown>;
    const parsed = TailscaleDeviceFeatureUpdateSchema.omit({ authKey: true }).safeParse(
      featureFields,
    );
    if (!parsed.success) {
      throw ProblemDetailsError.unprocessable(
        `Tailscale 字段不合法：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
      );
    }
    // Diff carries only the public projection — the auth key value never
    // enters the confirmation card, only its presence transition.
    const after = {
      ...parsed.data,
      hasAuthKey: authKey === undefined ? (before?.hasAuthKey ?? false) : authKey !== null,
    };
    return {
      diff: {
        op: before ? 'update' : 'add',
        path: `devices[${device.name}].features.tailscale`,
        ...(before ? { beforeYaml: stringify(before).trimEnd() } : {}),
        afterYaml: stringify(after).trimEnd(),
      },
    };
  },
  async execute(ctx, input) {
    const device = await mustGetDevice(ctx.profileId, input.device_id);
    const result = await putDeviceTailscaleFeature(
      ctx.profileId,
      input.device_id,
      toFeaturePayload(input),
    );
    return writeResult('update', `已配置设备 ${device.name} 的 Tailscale`, {
      feature: result.feature,
      warnings: result.warnings,
    });
  },
});

/* ─── remove_device_tailscale ───────────────────────────────────────── */

const RemoveTailscaleInput = z.object({
  device_id: z.uuid().describe('设备 id（先用 list_devices 拿）'),
});

const removeDeviceTailscale = defineWriteAction({
  name: 'remove_device_tailscale',
  description:
    '关闭一台设备的设备级 Tailscale：注入的 tailscale 节点、select 组与 tailnet CIDR 规则从该设备的渲染产物中移除（共享层与其它设备不受影响）。需用户确认。已存的 auth key 一并删除且不可恢复。',
  input: RemoveTailscaleInput,
  risk: 'write',
  summary: (i) => `关闭设备 ${i.device_id.slice(0, 8)}… 的 Tailscale`,
  async preview(ctx, input) {
    const device = await mustGetDevice(ctx.profileId, input.device_id);
    const before = publicDeviceFeatures(device.features).tailscale;
    if (!before) {
      throw ProblemDetailsError.unprocessable(`设备 ${device.name} 未启用 Tailscale。`);
    }
    return {
      diff: {
        op: 'delete',
        path: `devices[${device.name}].features.tailscale`,
        beforeYaml: stringify(before).trimEnd(),
      },
    };
  },
  async execute(ctx, input) {
    const device = await mustGetDevice(ctx.profileId, input.device_id);
    const result = await deleteDeviceTailscaleFeature(ctx.profileId, input.device_id);
    if (!result) {
      throw ProblemDetailsError.unprocessable(`设备 ${device.name} 未启用 Tailscale。`);
    }
    return writeResult('delete', `已关闭设备 ${device.name} 的 Tailscale`, {
      warnings: result.warnings,
    });
  },
});

export const DEVICE_READ_ACTIONS = [listDevices, previewDeviceConfig];
export const DEVICE_WRITE_ACTIONS = [
  createDeviceAction,
  updateDeviceAction,
  deleteDeviceAction,
  setDeviceTailscale,
  removeDeviceTailscale,
];
