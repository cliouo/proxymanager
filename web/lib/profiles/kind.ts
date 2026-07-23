/**
 * Profile 类型（kind）—— 「普通配置文件」与「模版」的唯一判定与文案源。
 *
 * `kind` 只影响三件事（见 DEVICE-LAYER-DESIGN.md §8.1），其余语义与普通
 * 配置文件完全一致（照样可编辑、可预览、可激活）：
 *
 *   1. 分发拒绝 —— `/api/sub/{token}/{profile}` 对模版 404（渲染之前拦截）；
 *   2. UI 分组与标识 —— 切换器 / 列表页把模版单列一节并加徽章；
 *   3. 新建流引导 —— copy_from 选择器把模版置顶为「从模版新建」。
 *
 * 判定与分组写成纯函数放这里，是因为它同时被服务端 route 与三个客户端组件
 * 用到，而组件本身（.tsx）不进 vitest 的 `tests/**\/*.test.ts` 收集范围 ——
 * 逻辑落在这个 .ts 模块里才测得到。
 */

/** 模版一律不分发；这句同时用在 route 的 404 detail 与 UI 禁用态里。 */
export const TEMPLATE_NOT_DISTRIBUTABLE = '模版不可分发';

/** 列表 / 切换器上的徽章字。 */
export const TEMPLATE_BADGE = '模版';

/**
 * 语义界碑 —— 模版与（后续 Phase 的）设备是两种完全不同的复用方式，用户最
 * 容易混淆的正是这一点，所以各处文案共用同一句，避免措辞漂移。
 */
export const TEMPLATE_TAGLINE = '模版＝拷贝一次、此后独立；设备＝持续跟随共享层。';

/** 判定只看 `kind` 一个字段所需的最小形状 —— 服务端 Profile 与前端本地类型都满足。 */
export interface ProfileKindLike {
  kind?: 'normal' | 'template';
}

/** 存量记录没有 `kind` → parse-forward 成 `normal`，所以缺字段一律不是模版。 */
export function isTemplateProfile(p: ProfileKindLike | null | undefined): boolean {
  return p?.kind === 'template';
}

/** 两组各自保持入参顺序（仓库已按 name 排序，不再二次排序）。 */
export function partitionProfilesByKind<T extends ProfileKindLike>(
  list: readonly T[],
): { normal: T[]; templates: T[] } {
  const normal: T[] = [];
  const templates: T[] = [];
  for (const p of list) (isTemplateProfile(p) ? templates : normal).push(p);
  return { normal, templates };
}

/**
 * 生产环境里既有的模版系列命名（simple* / general*）—— `migrate:profile-kind`
 * 按它决定给谁打 `kind: 'template'`。只有那个一次性迁移脚本用得上：`kind` 一旦
 * 落库，判定就一律走 {@link isTemplateProfile}，名字再也不参与任何决策。
 */
export const TEMPLATE_NAME_PREFIXES = ['simple', 'general'] as const;

/** 名字是否属于既有模版系列。仅供迁移脚本圈定名单。 */
export function matchesTemplateNameConvention(name: string): boolean {
  return TEMPLATE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 模版置顶 —— 新建弹窗的 copy_from 选择器用，「从模版新建」是主推路径。 */
export function templatesFirst<T extends ProfileKindLike>(list: readonly T[]): T[] {
  const { normal, templates } = partitionProfilesByKind(list);
  return [...templates, ...normal];
}
