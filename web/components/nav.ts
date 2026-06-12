/**
 * 侧边栏信息架构（v2「Signal Console」外壳与 Topbar 共享）。
 *
 * 分组对齐 open-design v2 原型:概览 / 当前配置文件 / 资源库·共享 / 系统。
 * 「绑定与设置」(profile-settings) 指向当前配置文件的设置页,id 是动态的,
 * 故不在此静态表里,由 Sidebar 用 ProfilesContext 的 current.id 现算。
 * 「配置文件」总览(/profiles)收编进侧边栏顶部的配置文件切换器,不再占独立导航项。
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

/** 概览 */
export const OVERVIEW_NAV: NavItem[] = [{ href: '/', label: '概览', icon: '◎' }];

/** 当前配置文件 —— 编辑当前生效配置文件的各个切面。 */
export const PROFILE_NAV: NavItem[] = [
  { href: '/base', label: '结构 base', icon: '{}' },
  { href: '/proxy-groups', label: '策略组', icon: '⌥' },
  { href: '/scenarios/rule-anchor-append', label: '规则', icon: '#' },
  { href: '/scenarios/chained-proxy', label: '链式代理', icon: '⛓' },
  { href: '/config', label: '最终配置', icon: '▣' },
];

/** 资源库 · 共享 —— 跨配置文件共享的节点与规则资源。 */
export const LIBRARY_NAV: NavItem[] = [
  { href: '/subscriptions', label: '订阅源', icon: '⇣' },
  { href: '/rule-sets', label: '规则集', icon: '≣' },
];

/** 系统 */
export const SYSTEM_NAV: NavItem[] = [
  { href: '/history', label: '操作历史', icon: '↺' },
  { href: '/assistant-settings', label: 'AI 配置', icon: '✦' },
  { href: '/docs', label: 'API 文档', icon: '❡' },
];

export const ALL_NAV: NavItem[] = [
  ...OVERVIEW_NAV,
  ...PROFILE_NAV,
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
  if (pathname.startsWith('/scenarios')) return '场景';
  return 'ProxyManager';
}
