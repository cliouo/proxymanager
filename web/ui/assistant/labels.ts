/**
 * Friendly Chinese labels for the assistant's tools (names come from the
 * server action registry via /assistant/bootstrap) plus short, human
 * summaries of their inputs and results for the activity rows.
 */

const TOOL_LABELS: Record<string, string> = {
  // reads
  get_base_overview: '查看基础配置概要',
  list_proxy_nodes: '列出可用节点',
  list_rules: '查看规则',
  list_proxy_groups: '查看策略组',
  list_profiles: '查看配置文件',
  get_config_outline: '查看配置结构',
  get_config_section: '读取配置片段',
  get_config_full: '读取最终配置',
  list_rule_providers: '查看规则集',
  preview_proxy_group_members: '试算策略组成员',
  list_node_sources: '查看订阅源与节点处理',
  preview_node_operators: '试算节点处理',
  list_naming_targets: '查看命名对象',
  inspect_naming_fields: '检查命名字段',
  inspect_source_name_clusters: '分析节点名称形态',
  inspect_naming_collisions: '检查重名冲突',
  inspect_node_parse: '查看节点解析',
  preview_naming_recognition: '试算名称识别',
  inspect_naming_drift: '检查命名漂移',
  preview_naming_target: '试算命名方案',
  list_local_nodes: '查看本地节点',
  list_devices: '查看设备',
  preview_device_config: '试算设备配置',
  preview_direct_alias_migration: '预检直连别名迁移',
  preview_legacy_profile_repair: '预检旧配置修复',
  preview_legacy_chain_profile_repair: '预检旧链式配置修复',
  fetch_url: '抓取网页',
  get_skill_reference: '查阅参考资料',
  search_mihomo_docs: '查阅 mihomo 文档',
  // writes
  add_rule: '新增规则',
  update_rule: '修改规则',
  delete_rule: '删除规则',
  create_profile: '新建配置文件',
  update_profile: '修改配置文件',
  create_rule_provider: '新建规则集',
  update_rule_provider: '修改规则集',
  delete_rule_provider: '删除规则集',
  localize_rule_provider: '转为托管规则集',
  create_proxy_group: '新建策略组',
  update_proxy_group: '修改策略组',
  repair_proxy_group_filters: '修复策略组筛选',
  delete_proxy_group: '删除策略组',
  add_operator: '新增节点处理步骤',
  update_operator: '修改节点处理步骤',
  delete_operator: '删除节点处理步骤',
  reorder_operators: '调整节点处理顺序',
  save_naming_plan: '保存命名方案',
  rename_local_node: '重命名本地节点',
  create_device: '新建设备',
  update_device: '修改设备',
  delete_device: '删除设备',
  set_device_tailscale: '设置设备 Tailscale',
  remove_device_tailscale: '关闭设备 Tailscale',
  set_config_section: '修改基础配置',
  delete_config_section: '删除基础配置片段',
  migrate_direct_alias: '迁移直连别名',
  repair_legacy_profile: '修复旧配置',
  repair_legacy_chain_profile: '修复旧链式配置',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `调用 ${name}`;
}

/* ─── input hints ────────────────────────────────────────────────────── */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const clip = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One short fragment describing what a call looks at (shown beside its label). */
export function describeInput(name: string, input: unknown): string | null {
  const args = asRecord(input);
  if (!args) return null;
  const str = (key: string) => (typeof args[key] === 'string' && args[key] ? (args[key] as string) : null);
  switch (name) {
    case 'get_config_section':
    case 'set_config_section':
    case 'delete_config_section':
      return str('path');
    case 'search_mihomo_docs':
      return str('query') ?? str('q');
    case 'fetch_url': {
      const url = str('url');
      if (!url) return null;
      try {
        return new URL(url).host;
      } catch {
        return clip(url);
      }
    }
    case 'get_skill_reference':
      return str('name');
    case 'list_rules':
      return str('anchor') ? `锚点 ${str('anchor')}` : null;
    case 'preview_proxy_group_members':
      return str('filter') ? clip(str('filter')!) : null;
    default:
      return null;
  }
}

/* ─── result summaries ───────────────────────────────────────────────── */

const UNITS: Record<string, string> = {
  'rule-list': '条规则',
  'proxy-group-list': '个策略组',
  'proxy-nodes': '个节点',
  'proxy-group-members': '个节点',
  'rule-provider-list': '个规则集',
  'device-list': '台设备',
  'profile-list': '个配置文件',
  'local-nodes': '个节点',
};

function firstArrayLength(record: Record<string, unknown>): number | null {
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/** Tiny result digest for a finished read ("26 条规则"), or null. */
export function describeResult(kind: string, data: unknown): string | null {
  if (kind === 'error') return null;
  if (Array.isArray(data)) return `${data.length} ${UNITS[kind] ?? '项'}`;
  const record = asRecord(data);
  if (!record) return null;
  if (kind === 'node-sources') {
    const subs = Array.isArray(record.subscriptions) ? record.subscriptions.length : 0;
    const pools = Array.isArray(record.collections) ? record.collections.length : 0;
    return pools ? `${subs} 个订阅源 · ${pools} 个聚合订阅` : `${subs} 个订阅源`;
  }
  if (kind === 'base-overview') {
    const anchors = Array.isArray(record.anchors) ? record.anchors.length : 0;
    const policies = Array.isArray(record.policies) ? record.policies.length : 0;
    return `${anchors} 个锚点 · ${policies} 个可用策略`;
  }
  const count = typeof record.count === 'number' ? record.count : firstArrayLength(record);
  if (count === null) return null;
  return `${count} ${UNITS[kind] ?? '项'}`;
}

/** The error text of a failed tool result (server errors are already sanitised). */
export function resultError(data: unknown): string {
  const record = asRecord(data);
  if (record && typeof record.error === 'string') return record.error;
  return '工具执行失败';
}
