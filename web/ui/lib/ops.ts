import {
  BookMarked,
  FileCode2,
  Layers,
  Link2,
  ListTree,
  MonitorSmartphone,
  Settings2,
  Sparkles,
  Undo2,
  Waypoints,
  Wand2,
  type LucideIcon,
} from 'lucide-react';

/** Human labels for audit-log operation ids (`scenario.action`). */
const OP_LABELS: Record<string, string> = {
  'rule.create': '新建规则',
  'rule.update': '修改规则',
  'rule.delete': '删除规则',
  'rule-anchor-append.create': '新建规则',
  'rule-anchor-append.batch-create': '批量新建规则',
  'rule-anchor-append.replace': '修改规则',
  'rule-anchor-append.patch': '修改规则',
  'rule-anchor-append.update': '修改规则',
  'rule-provider.update': '修改规则集',
  'tailscale.enable': '启用 Tailscale',
  'tailscale.disable': '停用 Tailscale',
  'config-section.delete-section': '删除配置分组',
  'rule-anchor-append.delete': '删除规则',
  'rules.move': '调整规则顺序',
  'rule-provider.create': '新建规则集',
  'rule-provider.replace': '修改规则集',
  'rule-provider.patch': '修改规则集',
  'rule-provider.delete': '删除规则集',
  'proxy-groups.reorder': '调整策略组顺序',
  'chained-proxy.set-fixed-chain': '设置固定链路',
  'chained-proxy.clear-chain': '移除链路',
  'chained-proxy.create-pool-chain': '新建前置池链路',
  'chained-proxy.create-smart-pool-chain': '新建智能前置池',
  'chained-proxy.update-pool-members': '修改前置池成员',
  'chained-proxy.update-smart-pool': '修改智能前置池',
  'chained-proxy.delete-pool-chain': '删除前置池链路',
  'config-section.set-section': '修改配置分组',
  'device.create': '新增设备',
  'device.update': '修改设备',
  'device.delete': '删除设备',
  'device.tailscale.update': '更新设备 Tailscale',
  'device.tailscale.delete': '移除设备 Tailscale',
  'device.tailscale.migrate': '迁移 Tailscale 到设备',
  'tailscale.update-auth-key': '更新 Tailscale 密钥',
  'naming.apply': '应用智能命名',
  'naming.rollback': '回滚智能命名',
  'setup.bootstrap': '初始化工作区',
  'legacy-profile-repair.apply': '修复旧版配置',
  'legacy-chain-profile-repair.apply': '修复旧版链式代理',
  'direct-migration.replace-alias': '迁移直连别名',
};

export function opLabel(op: string): string {
  if (OP_LABELS[op]) return OP_LABELS[op];
  const action = op.slice(op.lastIndexOf('.') + 1);
  const verb: Record<string, string> = {
    create: '新建',
    update: '修改',
    patch: '修改',
    replace: '修改',
    delete: '删除',
    apply: '应用',
    rollback: '回滚',
  };
  return verb[action] ? `${verb[action]} · ${op.slice(0, op.lastIndexOf('.'))}` : op;
}

export function opIcon(op: string): LucideIcon {
  if (op.startsWith('rule-provider')) return BookMarked;
  if (op.startsWith('rule')) return ListTree;
  if (op.startsWith('proxy-group')) return Waypoints;
  if (op.startsWith('chained-proxy')) return Link2;
  if (op.startsWith('device') || op.startsWith('tailscale')) return MonitorSmartphone;
  if (op.startsWith('naming')) return Wand2;
  if (op.startsWith('setup')) return Sparkles;
  if (op.startsWith('config-section')) return Settings2;
  if (op.includes('repair') || op.includes('migration')) return FileCode2;
  return Layers;
}

export const UndoIcon = Undo2;
