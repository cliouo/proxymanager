import {
  BookMarked,
  FileCode2,
  History,
  Layers,
  LayoutGrid,
  Link2,
  ListTree,
  MonitorSmartphone,
  RadioTower,
  ScrollText,
  Settings,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Path relative to the profile root, or absolute for global pages. */
  href: string;
  scoped: boolean;
  hint?: string;
  shortcut?: string;
}

export const PROFILE_NAV: NavItem[] = [
  { id: 'overview', label: '总览', icon: LayoutGrid, href: '', scoped: true, shortcut: 'G O', hint: '状态、分流图和订阅链接' },
  { id: 'groups', label: '策略组', icon: Waypoints, href: 'groups', scoped: true, shortcut: 'G G', hint: '流量的出口：选哪个节点' },
  { id: 'rules', label: '规则', icon: ListTree, href: 'rules', scoped: true, shortcut: 'G R', hint: '什么流量走哪个策略组' },
  { id: 'devices', label: '设备', icon: MonitorSmartphone, href: 'devices', scoped: true, shortcut: 'G D', hint: '每台设备的差异与订阅链接' },
  { id: 'chains', label: '链式代理', icon: Link2, href: 'chains', scoped: true, hint: '前置节点 → 落地节点' },
  { id: 'base', label: '基础配置', icon: FileCode2, href: 'base', scoped: true, shortcut: 'G B', hint: 'DNS、TUN、端口等 YAML 骨架' },
  { id: 'output', label: '最终配置', icon: ScrollText, href: 'output', scoped: true, hint: '客户端实际拿到的完整配置' },
];

export const LIBRARY_NAV: NavItem[] = [
  { id: 'sources', label: '节点来源', icon: RadioTower, href: '/sources', scoped: false, shortcut: 'G S', hint: '订阅源与聚合订阅（全局共享）' },
  { id: 'rule-sets', label: '规则集', icon: BookMarked, href: '/rule-sets', scoped: false, hint: '可被规则引用的规则列表' },
  { id: 'profiles', label: '配置文件', icon: Layers, href: '/profiles', scoped: false, hint: '多份配置与模版' },
];

export const SYSTEM_NAV: NavItem[] = [
  { id: 'history', label: '操作历史', icon: History, href: '/history', scoped: false, shortcut: 'G H', hint: '审计日志与撤销' },
  { id: 'settings', label: '设置', icon: Settings, href: '/settings', scoped: false, hint: '外观、AI 助手、连接信息' },
];

export const ALL_NAV = [...PROFILE_NAV, ...LIBRARY_NAV, ...SYSTEM_NAV];
