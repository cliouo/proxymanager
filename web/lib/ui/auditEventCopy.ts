/**
 * Audit event → human copy, shared by /history and the dashboard's recent
 * activity panel. Pure (no React) so the mapping can be unit-tested.
 *
 * An op is `<scope>.<action>` (e.g. `rule-anchor-append.create`); the scope
 * is the feature that wrote it, the action is the verb. The sentence reads
 * "<verb><subject>" — 新增规则 / 调整分流规则顺序 — with the subject taken from
 * the event target first and the scope second.
 */

export type ActivityTone = 'create' | 'update' | 'delete' | 'move' | 'undo' | 'ai';

export interface AuditEventLike {
  op: string;
  actor: string;
  ruleId?: string;
  target?: { kind: string };
  undoes?: string;
}

/** The action is the op's last dotted segment; the scope is everything before. */
export function actionOf(op: string): string {
  const i = op.lastIndexOf('.');
  return i === -1 ? op : op.slice(i + 1);
}

function scopeOf(op: string): string {
  const i = op.lastIndexOf('.');
  return i === -1 ? '' : op.slice(0, i);
}

const VERBS: Record<string, { label: string; tone: ActivityTone }> = {
  create: { label: '新增', tone: 'create' },
  add: { label: '新增', tone: 'create' },
  'batch-create': { label: '批量新增', tone: 'create' },
  'create-pool-chain': { label: '新建链路', tone: 'create' },
  bootstrap: { label: '初始化', tone: 'create' },
  update: { label: '修改', tone: 'update' },
  'batch-update': { label: '批量修改', tone: 'update' },
  patch: { label: '修改', tone: 'update' },
  set: { label: '设置', tone: 'update' },
  'set-section': { label: '设置', tone: 'update' },
  'set-fixed-chain': { label: '设置固定链路', tone: 'update' },
  'update-pool-members': { label: '调整链路成员', tone: 'update' },
  'update-smart-pool': { label: '调整智能前置池', tone: 'update' },
  'replace-alias': { label: '替换别名', tone: 'update' },
  replace: { label: '替换', tone: 'update' },
  apply: { label: '应用', tone: 'update' },
  migrate: { label: '迁移', tone: 'update' },
  enable: { label: '启用', tone: 'update' },
  disable: { label: '停用', tone: 'update' },
  mark: { label: '标记', tone: 'update' },
  move: { label: '调整顺序', tone: 'move' },
  reorder: { label: '调整顺序', tone: 'move' },
  rollback: { label: '回滚', tone: 'undo' },
  delete: { label: '删除', tone: 'delete' },
  del: { label: '删除', tone: 'delete' },
  'delete-section': { label: '删除', tone: 'delete' },
  'delete-pool-chain': { label: '删除链路', tone: 'delete' },
  'clear-chain': { label: '清空链路', tone: 'delete' },
};

const SUBJECT_BY_KIND: Record<string, string> = {
  rule: '规则',
  'rule-set': '规则资源',
  'proxy-group': '策略组',
  proxy: '节点',
  base: '基础配置',
  device: '设备',
  'naming-source': '命名',
};

/**
 * The scope names the subject first: profile-scoped events (bulk reorders,
 * repairs) carry no specific target, and the dashboard's event summaries
 * carry no target at all.
 */
const SUBJECT_BY_SCOPE: Record<string, string> = {
  rules: '分流规则',
  rule: '规则',
  'rule-anchor-append': '规则',
  'rule-provider': '规则资源',
  'proxy-groups': '策略组',
  'config-section': '基础配置',
  device: '设备',
  'device.tailscale': '设备 Tailscale',
  tailscale: 'Tailscale',
  'legacy-profile-repair': '旧版配置修复',
  'legacy-chain-profile-repair': '旧版链路修复',
  setup: '首次设置',
  naming: '命名',
};

/** Verbs whose label already carries its object (新建链路, 替换别名…). */
const SELF_CONTAINED = new Set([
  'create-pool-chain',
  'set-fixed-chain',
  'update-pool-members',
  'update-smart-pool',
  'delete-pool-chain',
  'clear-chain',
  'replace-alias',
]);

const ACTORS: Record<string, string> = {
  'web-ui': '网页',
  admin: '管理 API',
  ai_chat: '配置助手',
  extension: '浏览器扩展',
  'localize-script': '本地化脚本',
  migration: '迁移脚本',
};

/** AI-authored events get the AI tone regardless of verb. */
export function isAiActor(actor: string): boolean {
  return /ai|assistant|助手/i.test(actor);
}

export function actorLabel(actor: string): string {
  return ACTORS[actor] ?? actor;
}

export function describeAuditEvent(e: AuditEventLike): { title: string; tone: ActivityTone } {
  const action = actionOf(e.op);
  const verb = VERBS[action] ?? { label: action, tone: 'update' as ActivityTone };
  const kind = e.target?.kind ?? (e.ruleId ? 'rule' : undefined);
  const subject = SELF_CONTAINED.has(action)
    ? ''
    : (SUBJECT_BY_SCOPE[scopeOf(e.op)] ?? (kind ? SUBJECT_BY_KIND[kind] : undefined) ?? '');
  // 调整顺序 reads better wrapped around its object: 调整分流规则顺序.
  const title = verb.tone === 'move' && subject ? `调整${subject}顺序` : `${verb.label}${subject}`;
  if (e.undoes) return { title: `撤销 · ${title}`, tone: 'undo' };
  return { title, tone: isAiActor(e.actor) ? 'ai' : verb.tone };
}

/**
 * Collapses runs of consecutive same-op, same-actor events (a drag-reorder
 * session writes one `rules.move` per drop). Runs shorter than `min` stay
 * as single items so ordinary history is untouched.
 */
export function groupConsecutive<T extends { op: string; actor: string }>(
  events: T[],
  min = 3,
): Array<{ kind: 'single'; event: T } | { kind: 'run'; events: T[] }> {
  const out: Array<{ kind: 'single'; event: T } | { kind: 'run'; events: T[] }> = [];
  let i = 0;
  while (i < events.length) {
    let j = i + 1;
    while (
      j < events.length &&
      events[j].op === events[i].op &&
      events[j].actor === events[i].actor
    )
      j++;
    if (j - i >= min) out.push({ kind: 'run', events: events.slice(i, j) });
    else for (let k = i; k < j; k++) out.push({ kind: 'single', event: events[k] });
    i = j;
  }
  return out;
}
