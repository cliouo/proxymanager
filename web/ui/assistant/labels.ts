const TOOL_LABELS: Record<string, string> = {
  snapshot: '查看当前页面',
  query: '查询页面内容',
  act: '操作页面',
  wait_for: '等待页面内容就绪',
  get_node_catalog_summary: '读取节点地区分布摘要',
  search_mihomo_docs: '查询 Mihomo 文档',
  fetch_url: '抓取外部链接',
  preview_direct_alias_migration: '预检直连别名迁移',
  migrate_direct_alias: '迁移直连别名',
  preview_legacy_profile_repair: '预检旧配置恢复',
  repair_legacy_profile: '恢复旧配置',
  preview_legacy_chain_profile_repair: '预检旧链配置恢复',
  repair_legacy_chain_profile: '恢复旧链配置',
};

const ACTION_LABELS: Record<string, string> = {
  press: '点击',
  click: '点击',
  setValue: '设置',
  setChecked: '切换',
  toggle: '切换',
  open: '展开',
  close: '收起',
  clear: '清空',
  expect: '检查',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `调用 ${name}`;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const clip = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function describeInput(name: string, input: unknown): string | null {
  const args = asRecord(input);
  if (!args) return null;

  if (name === 'query') {
    const parts: string[] = [];
    if (typeof args.within === 'string' && args.within) parts.push(args.within);
    if (typeof args.text === 'string' && args.text) parts.push(`“${args.text}”`);
    if (typeof args.kind === 'string' && args.kind) parts.push(args.kind);
    if (args.closed === true) parts.push('含折叠区');
    if (typeof args.from === 'number' && args.from > 0) parts.push(`自第 ${args.from + 1} 项`);
    return parts.length ? clip(parts.join(' · ')) : null;
  }

  if (name === 'act' && Array.isArray(args.steps) && args.steps.length > 0) {
    const first = asRecord(args.steps[0]);
    if (!first) return `${args.steps.length} 步`;
    const ref = typeof first.ref === 'string' ? first.ref : '';
    const action = typeof first.action === 'string' ? (ACTION_LABELS[first.action] ?? first.action) : '';
    const head = [action, ref].filter(Boolean).join(' ');
    if (args.steps.length === 1) return head ? clip(head) : null;
    return head ? clip(`${head} 等 ${args.steps.length} 步`) : `${args.steps.length} 步`;
  }

  if (name === 'wait_for') {
    const parts: string[] = [];
    if (typeof args.text === 'string' && args.text.trim()) parts.push(`“${args.text.trim()}”`);
    if (typeof args.component === 'string' && args.component.trim()) parts.push(args.component.trim());
    return parts.length ? clip(parts.join(' · ')) : '骨架屏加载完成';
  }
  if (name === 'get_node_catalog_summary') {
    if (typeof args.profile === 'string' && args.profile.trim()) return clip(`配置「${args.profile.trim()}」`);
    if (typeof args.pool_id === 'string' && args.pool_id.trim()) return '指定聚合订阅';
    if (typeof args.subscription_id === 'string' && args.subscription_id.trim()) return '指定订阅源';
    return '当前节点分布';
  }
  if (name === 'search_mihomo_docs' && typeof args.question === 'string') {
    return clip(args.question);
  }
  if (name === 'fetch_url' && typeof args.url === 'string') {
    return clip(args.url);
  }
  if (
    (name === 'preview_direct_alias_migration' ||
      name === 'migrate_direct_alias' ||
      name === 'preview_legacy_profile_repair' ||
      name === 'repair_legacy_profile' ||
      name === 'preview_legacy_chain_profile_repair' ||
      name === 'repair_legacy_chain_profile') &&
    typeof args.alias === 'string'
  ) {
    return clip(`别名「${args.alias}」`);
  }

  return null;
}

export function describeResult(kind: string, data: unknown): string | null {
  if (kind === 'error') return null;
  if (kind === 'snapshot' && Array.isArray(data)) {
    const more = data.find((entry) => asRecord(entry)?.component === 'more');
    const count = more ? data.length - 1 : data.length;
    const extra = more && typeof asRecord(more)?.more === 'number' ? `（另有 ${asRecord(more)!.more} 个）` : '';
    return `${count} 个控件${extra}`;
  }
  if (kind === 'query' && Array.isArray(data)) {
    if (data.length === 1) {
      const only = asRecord(data[0]);
      if (only && Array.isArray(only.items)) {
        const extra = typeof only.more === 'number' && only.more > 0 ? `（另有 ${only.more} 项）` : '';
        return `${only.items.length} 项${extra}`;
      }
    }
    return `${data.length} 个结果`;
  }
  if (kind === 'act') {
    const record = asRecord(data);
    if (record && Array.isArray(record.steps)) {
      return `${record.steps.length} 步完成`;
    }
  }
  if (kind === 'custom') {
    const record = asRecord(data);
    if (typeof record?.found === 'boolean') {
      const ms = typeof record.waitedMs === 'number' ? `（${record.waitedMs}ms）` : '';
      return record.found ? `已就绪${ms}` : '等待超时';
    }
    if (typeof record?.totalNodes === 'number') {
      const regionCount = Array.isArray(record.regions) ? record.regions.length : 0;
      return `${record.totalNodes} 个节点 · ${regionCount} 类地区`;
    }
    if (record?.unavailable === true) return '文档服务暂不可用';
    if (typeof record?.bytes === 'number') return `${record.bytes} 字节`;
    if (typeof record?.newVersion === 'number') return `版本 v${record.newVersion}`;
    if (record?.safe === true) return '预检通过';
  }

  return null;
}

export function resultError(data: unknown): string {
  const record = asRecord(data);
  if (!record) return '工具执行失败';
  if (typeof record.error === 'string') return record.error;
  const nested = asRecord(record.error);
  if (nested && typeof nested.message === 'string') return nested.message;
  return '工具执行失败';
}
