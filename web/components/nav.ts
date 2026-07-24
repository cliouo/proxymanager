import type { NavIconName } from '@/components/NavIcon';

/**
 * 侧边栏信息架构。标签优先描述用户任务，description 再补充底层含义。
 *
 * 当前配置文件组仍按真实数据流排序，但不要求新用户先理解 base、anchor
 * 或 proxy-group 等 Mihomo 术语。动态的配置文件设置项由 Sidebar 生成。
 */
export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
  description?: string;
}

/** 概览 */
export const OVERVIEW_NAV: NavItem[] = [
  { href: '/', label: '概览', icon: 'overview', description: '状态与常用入口' },
];

/** 当前配置文件 —— 编辑当前生效配置文件的各个切面，顺序即数据流。 */
export const PROFILE_NAV: NavItem[] = [
  { href: '/base', label: '基础配置', icon: 'base', description: '端口、DNS 与运行选项' },
  { href: '/proxy-groups', label: '代理策略', icon: 'groups', description: '选择、测速与故障转移' },
  { href: '/rules', label: '分流规则', icon: 'rules', description: '决定不同流量的去向' },
  { href: '/config', label: '配置预览', icon: 'config', description: '检查并导出 YAML' },
  { href: '/devices', label: '设备', icon: 'devices', description: '差异配置与设备链接' },
];

/** 低频但完整可用的高级配置。数量很少时保持扁平，不增加折叠层级。 */
export const ADVANCED_NAV: NavItem[] = [
  {
    href: '/scenarios/chained-proxy',
    label: '链式代理',
    icon: 'chain',
    description: '组合前置与落地出口',
  },
];

/** 资源库 · 共享 —— 跨配置文件共享的节点与规则资源。 */
export const LIBRARY_NAV: NavItem[] = [
  {
    href: '/subscriptions',
    label: '节点订阅',
    icon: 'subscriptions',
    description: '跨配置文件共享的节点',
  },
  {
    href: '/rule-sets',
    label: '规则资源',
    icon: 'ruleSets',
    description: '跨配置文件共享的规则',
  },
];

/** 系统 */
export const SYSTEM_NAV: NavItem[] = [
  { href: '/history', label: '操作记录', icon: 'history' },
  { href: '/assistant-settings', label: '助手设置', icon: 'assistant' },
  { href: '/docs', label: '开发者文档', icon: 'docs' },
];

export const ALL_NAV: NavItem[] = [
  ...OVERVIEW_NAV,
  ...PROFILE_NAV,
  ...ADVANCED_NAV,
  ...LIBRARY_NAV,
  ...SYSTEM_NAV,
];

/** topbar 标题：精确命中优先，否则取最长前缀，再退到分类兜底。 */
export function titleForPath(pathname: string): string {
  const exact = ALL_NAV.find((n) => n.href === pathname);
  if (exact) return exact.label;

  const prefix = ALL_NAV.filter((n) => n.href !== '/' && pathname.startsWith(n.href)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0];
  if (prefix) return prefix.label;

  if (pathname.startsWith('/profiles')) return '配置文件';
  if (pathname.startsWith('/scenarios')) return '进阶功能';
  return 'ProxyManager';
}
