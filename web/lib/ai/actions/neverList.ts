/**
 * Never-List — operations the AI must never perform, checked before any write
 * is even previewed. This is a hard denylist independent of which actions are
 * registered: even if a dangerous action were added to the registry by
 * mistake, the orchestrator refuses it here.
 *
 * Curation rule: an operation lands here when a single confirmed card cannot
 * meaningfully convey its blast radius — irreversible whole-resource loss,
 * credential/token change, or breaking every distributed client link at once.
 * A registry test asserts none of these names is ever registered.
 */

import type { ActionDef } from './types';

/** Action names that must never be AI-invocable, even if registered. */
export const NEVER_LIST_ACTIONS = new Set<string>([
  // 整份 profile 连根删除（base/规则/策略组/设备一并消失，无逆操作）——
  // profile 生命周期里唯一 UI-only 的一环（create/update 已注册）。
  'delete_profile',
  // 鉴权面：ADMIN_KEY / 登录凭证。AI 改鉴权 = 改掉自己被门控的锁。
  'edit_auth',
  // 分发令牌轮换：令牌是 secret（AI 全程不可见），且轮换瞬间废掉所有已导入
  // 客户端的订阅链接。
  'rotate_sub_token',
  // 整块覆盖 base 文件。写骨架只允许路径级 set_config_section（有禁改根表）；
  // 全文覆盖会绕过锚点/标记完整性检查。
  'overwrite_base',
  // 无差别批量删规则。删除必须逐条（delete_rule 单条 + 确认卡），批量清理走
  // optimizing-whole-config 的逐条编号清单。
  'bulk_delete_rules',
]);

export class NeverListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeverListError';
  }
}

/**
 * Throw if this action is forbidden for the AI. Called before preview and
 * again before execute (defense in depth).
 */
export function assertWriteAllowed(action: ActionDef): void {
  if (NEVER_LIST_ACTIONS.has(action.name)) {
    throw new NeverListError(`操作 "${action.name}" 不允许由 AI 执行。`);
  }
  if (action.risk !== 'write') {
    // Only write actions go through the confirmation path.
    throw new NeverListError(`"${action.name}" 不是写操作。`);
  }
}
