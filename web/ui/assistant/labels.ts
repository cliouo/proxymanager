const TOOL_LABELS: Record<string, string> = {
  snapshot: '查看当前页面',
  query: '查询页面内容',
  act: '操作页面',
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
