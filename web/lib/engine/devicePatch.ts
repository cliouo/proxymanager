/**
 * 设备补丁引擎 —— 纯函数，无 I/O。
 *
 * 补丁语义是严格的 RFC 7386 JSON Merge Patch，作用对象是**最终渲染产物**
 * （YAML parse 出来的顶层对象，锚点已被渲染器解析掉，没有 YAML 玄学）：
 *
 *   - 对象递归深合并；
 *   - 数组与标量整段替换；
 *   - `null` 删除该键。
 *
 * 刻意不做的两件事：按索引 patch 列表（上游一变索引就漂移，必炸），以及按 key
 * 合并列表（需要逐区块的 schema 知识，等于把 mihomo 的模型抄一遍）。
 *
 * **正确性不靠合并引擎聪明，靠产物全量校验** —— patch 之后的完整文档要过
 * `parseBaseDocument`（结构）与 `validateFinalRenderedConfig`（跨区块引用），
 * 这两个都是既有校验入口，本文件不新写任何配置规则。
 */

import { parseDocument, stringify } from 'yaml';
import { ConfigValidationError } from '@/lib/config/errors';
import { parseBaseDocument } from '@/lib/engine/parser';
import { validateFinalRenderedConfig } from '@/lib/engine/resolve';
import { MAX_BASE_PATCH_BYTES, MAX_BASE_PATCH_DEPTH } from '@/schemas';

/**
 * 由共享层管理的区块 —— 补丁里出现即拒。
 *
 * 这些区块是「配置文件」这一层的产物（节点来自订阅源、策略组与规则各有自己的
 * 管理页），设备级差异如果能改它们，等价于偷偷复制了一份配置文件而不告诉用户，
 * 且共享层的任何改动都会与之打架。真需要按设备不同的策略组 → 克隆 profile。
 *
 * `proxy-providers` 与 `proxies` 同理：它是**另一个节点来源入口**，设备补丁若能写
 * 它，这台设备就能拉到共享层完全不知情的节点 —— 节点来源只能由配置文件的绑定决定。
 */
export const MANAGED_PATCH_KEYS = [
  'proxies',
  'proxy-groups',
  'proxy-providers',
  'rules',
  'rule-providers',
] as const;

/**
 * 值需要掩码的键（大小写不敏感，嵌套层级同样命中）。
 *
 * 掩码只作用于**审计快照与 UI 回显**，落库的补丁保存原值 —— 否则 `***` 会被当成
 * 真值写进设备配置。沿用 tailscale 场景对 auth-key 的既有先例。
 */
export const SENSITIVE_PATCH_KEYS = [
  'secret',
  'auth-key',
  'authentication',
  'password',
  'private-key',
  'token',
] as const;

/** 掩码后的占位值。 */
export const REDACTED = '***';

const MANAGED_KEY_SET = new Set<string>(MANAGED_PATCH_KEYS);
const SENSITIVE_KEY_SET = new Set<string>(SENSITIVE_PATCH_KEYS);

export type PatchObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PatchObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(key.toLowerCase());
}

/* ─── RFC 7386 ──────────────────────────────────────────────────────── */

/**
 * 严格 RFC 7386 合并。`target` 不被修改（返回新对象）。
 *
 * `patch` 里的 `null` 删除对应键；对象递归；其余（数组/标量）整体替换。
 */
export function applyDevicePatch(target: PatchObject, patch: PatchObject): PatchObject {
  const out: PatchObject = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (isPlainObject(value)) {
      const current = out[key];
      // RFC 7386: 目标侧不是对象（标量/数组/缺失）时，先视作空对象再合并 ——
      // 补丁里的对象永远是「深合并」意图，不会退化成整体替换。
      out[key] = applyDevicePatch(isPlainObject(current) ? current : {}, value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 补丁触及的顶层键（含用 `null` 删除的那些）—— UI 的「N 项差异」与徽章用。 */
export function patchedTopLevelKeys(patch: PatchObject): string[] {
  return Object.keys(patch);
}

/* ─── 敏感键掩码 ────────────────────────────────────────────────────── */

/**
 * 递归掩码敏感键的值，用于审计 before/after 快照与前端回显。
 * 数组内的对象同样处理；非对象值原样保留。
 */
export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: PatchObject = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * 补丁里是否出现过敏感键（任意层级）。
 *
 * 命中即**不注册 inverse**：审计快照是掩码过的，用它「撤销」会把 `***` 当真值
 * 写回去 —— 与 tailscale `update-auth-key` 无 inverse 的既有决策同源。
 */
export function touchesSensitiveKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => touchesSensitiveKeys(item));
  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, v]) => isSensitiveKey(key) || touchesSensitiveKeys(v));
  }
  return false;
}

/* ─── 静态校验（apply 之前，422 短路） ──────────────────────────────── */

function patchIssue(code: string, message: string, path: string): ConfigValidationError {
  return new ConfigValidationError({
    code,
    message,
    section: 'devices',
    path,
    resource: 'device-patch',
  });
}

/**
 * 容器嵌套深度：顶层对象算第 1 层，标量不占层。
 * `{a: 1}` → 1；`{a: {b: 1}}` → 2；`{a: [[1]]}` → 3。
 */
function measureDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let max = 0;
    for (const item of value) max = Math.max(max, measureDepth(item));
    return 1 + max;
  }
  if (isPlainObject(value)) {
    let max = 0;
    for (const v of Object.values(value)) max = Math.max(max, measureDepth(v));
    return 1 + max;
  }
  return 0;
}

/**
 * §3.2 的 1–3 条：形状、管控键黑名单、尺寸与深度上限。
 * 第 4 条（patch 后的文档过 base 结构校验）在 {@link renderDevicePatchedYaml} 里，
 * 因为它需要合并后的完整文档。
 */
export function assertValidDevicePatch(
  patch: unknown,
  deviceLabel: string,
): asserts patch is PatchObject {
  if (!isPlainObject(patch)) {
    throw patchIssue(
      'device_patch_not_object',
      `设备「${deviceLabel}」的补丁必须是一个键值对象。`,
      'base_patch',
    );
  }

  for (const key of Object.keys(patch)) {
    if (MANAGED_KEY_SET.has(key)) {
      throw patchIssue(
        'device_patch_managed_key',
        `设备「${deviceLabel}」的补丁不能写 "${key}" —— 节点、策略组、规则、规则集由共享层统一管理；` +
          `确实需要按设备不同，请另建一份配置文件。`,
        `base_patch.${key}`,
      );
    }
  }

  // 序列化尺寸用 JSON 度量：这正是落库形态（Redis hash field 存 JSON）。
  let serialised: string;
  try {
    serialised = JSON.stringify(patch);
  } catch {
    throw patchIssue(
      'device_patch_not_serialisable',
      `设备「${deviceLabel}」的补丁无法序列化（可能含循环引用）。`,
      'base_patch',
    );
  }
  if (serialised === undefined) {
    throw patchIssue(
      'device_patch_not_serialisable',
      `设备「${deviceLabel}」的补丁无法序列化。`,
      'base_patch',
    );
  }
  const bytes = Buffer.byteLength(serialised, 'utf8');
  if (bytes > MAX_BASE_PATCH_BYTES) {
    throw patchIssue(
      'device_patch_too_large',
      `设备「${deviceLabel}」的补丁过大（${bytes} 字节，上限 ${MAX_BASE_PATCH_BYTES}）。`,
      'base_patch',
    );
  }

  const depth = measureDepth(patch);
  if (depth > MAX_BASE_PATCH_DEPTH) {
    throw patchIssue(
      'device_patch_too_deep',
      `设备「${deviceLabel}」的补丁嵌套过深（${depth} 层，上限 ${MAX_BASE_PATCH_DEPTH}）。`,
      'base_patch',
    );
  }
}

/* ─── 合并到 YAML 产物 ──────────────────────────────────────────────── */

/**
 * 把补丁合并进**已渲染的 YAML 文本**，返回设备的最终 YAML。
 *
 * 走 yaml 的 Document AST 而不是「parse → 合并 → 整体 stringify」，是为了让**没被
 * 补丁碰到的部分逐字节保持原样**（注释、键序、引号风格全部不动）。这不是洁癖：
 *   - §7.2 的生效预览是共享渲染 vs 设备渲染的 diff，整体重排会让 diff 里全是噪音，
 *     真正的差异反而看不见；
 *   - mihomo 配置里的注释是用户自己写的说明，重排即丢失。
 *
 * 合并语义仍是 {@link applyDevicePatch} 那一套 —— 顶层每个键各自算出合并后的值，
 * 再写回文档；`null` 直接删键。
 */
export function renderDevicePatchedYaml(sharedYaml: string, patch: PatchObject): string {
  const doc = parseDocument(sharedYaml);
  if (doc.errors.length > 0) {
    throw patchIssue(
      'device_patch_shared_unparsable',
      '共享渲染产物不是合法 YAML，无法叠加设备补丁。',
      '$',
    );
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      doc.delete(key);
      continue;
    }
    if (isPlainObject(value)) {
      const current = doc.toJS()?.[key];
      doc.set(key, applyDevicePatch(isPlainObject(current) ? current : {}, value));
      continue;
    }
    doc.set(key, value);
  }

  return doc.toString();
}

/**
 * 把一份渲染产物里的敏感值就地掩码，返回新的 YAML 文本。
 *
 * 只给**预览**用：预览是纯展示面，不该把 secret / auth-key 这些真值再搬一遍到
 * 一个新接口上。真正下发的 `/api/sub/...` 当然是原值 —— 那是配置本身。
 *
 * 代价明说：共享侧与设备侧同一个敏感键都会变成 `***`，于是 diff 里看不出「这台
 * 设备改了 secret」。这是可接受的 —— 差异卡片层已经用「***（已设置）」表达了
 * 「这台设备覆盖了它」，diff 只是用来看结构性差异的。
 */
export function redactRenderedYaml(content: string): string {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return content;
  const root = doc.toJS() as unknown;
  if (!isPlainObject(root)) return content;
  return stringify(redactSensitive(root));
}

/**
 * 设备渲染的**唯一**入口：静态校验 → 合并 → 结构校验 → 全量最终校验。
 *
 * 三道校验全部复用既有入口，本层不写新规则：
 *   1. {@link assertValidDevicePatch} —— 形状 / 管控键 / 尺寸深度（§3.2 1-3）；
 *   2. `parseBaseDocument` —— `/api/v1/base` 保存走的同一套结构校验：顶层必须是
 *      映射、禁 `<<` 合并键、各区块的 seq/map 形状（§3.2 4）；
 *   3. `validateFinalRenderedConfig` —— resolveConfig 对最终产物跑的 mihomo 全量
 *      校验：组类型/重名/DAG/规则策略目标（§3.3）。
 *
 * preflight 与设备渲染都调它，所以「设备产物合法」在整个系统里只有一个定义。
 */
export function buildDeviceConfig(sharedYaml: string, patch: unknown, deviceLabel: string): string {
  assertValidDevicePatch(patch, deviceLabel);
  const patched = renderDevicePatchedYaml(sharedYaml, patch);

  // parseBaseDocument 抛的 BaseParseError 本身就是 ConfigValidationError，但它的
  // 措辞是「base 怎么了」—— 设备场景要点名是哪台设备，否则用户在共享层保存被拦时
  // 完全不知道该去改哪台设备的补丁。
  try {
    parseBaseDocument(patched);
  } catch (error) {
    throw patchIssue(
      error instanceof ConfigValidationError ? error.issue.code : 'device_patch_structure_invalid',
      `设备「${deviceLabel}」的补丁使配置结构非法：${
        error instanceof Error ? error.message : '未知结构错误'
      }`,
      error instanceof ConfigValidationError ? error.issue.path : 'base_patch',
    );
  }

  try {
    validateFinalRenderedConfig(patched);
  } catch (error) {
    throw patchIssue(
      'device_patch_final_invalid',
      `设备「${deviceLabel}」的补丁使最终配置校验失败：${
        error instanceof Error ? error.message : '未知校验错误'
      }`,
      'base_patch',
    );
  }

  return patched;
}
