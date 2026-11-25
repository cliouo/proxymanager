'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import { motion } from 'motion/react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, PanelLeftClose, PanelLeftOpen, Search, Sparkles, Sun } from 'lucide-react';
import type { Profile } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Kbd, SegmentedControl, Tooltip } from '@/ui/primitives';
import { Wordmark, LogoMark } from '@/ui/viz/logo';
import { LIBRARY_NAV, PROFILE_NAV, SYSTEM_NAV, type NavItem } from './nav';
import { ProfileSwitcher } from './profile-switcher';
import { intentProps } from './prefetch';
import { profilePath, useActiveProfile } from './scope';
import { modKey } from './hotkeys';
import { openAssistant, openPalette, setUi, useUi } from './state';

function hrefFor(item: NavItem, profileName: string | null): string {
  if (!item.scoped) return item.href;
  return profileName ? profilePath(profileName, item.href || undefined) : '/';
}

function isActive(item: NavItem, pathname: string, profileName: string | null): boolean {
  if (!item.scoped) return pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.id === 'sources' && pathname.startsWith('/pools'));
  if (!profileName) return false;
  const base = profilePath(profileName);
  if (item.href === '') return pathname === base;
  const target = `${base}/${item.href}`;
  return pathname === target || pathname.startsWith(`${target}/`);
}

function NavLink({
  item,
  href,
  active,
  collapsed,
  onNavigate,
  profile,
}: {
  item: NavItem;
  href: string;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
  profile: Profile | null;
}) {
  const Icon = item.icon;
  const link = (
    <UiButton
      render={<Link href={href} {...intentProps(href, profile)} />}
      onClick={() => onNavigate?.()}
      aria-label={collapsed ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-8 items-center gap-2.5 rounded-lg text-[13px] font-medium outline-none transition-colors',
        collapsed ? 'w-9 justify-center' : 'px-2.5',
        active ? 'text-ink' : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
        'focus-visible:ring-2 focus-visible:ring-accent/40',
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-lg border border-line bg-surface shadow-sm"
          transition={{ type: 'spring', bounce: 0.14, duration: 0.42 }}
        />
      )}
      <Icon
        size={16}
        strokeWidth={active ? 2 : 1.75}
        className={cn('relative z-10 shrink-0', active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2')}
      />
      {!collapsed && <span className="relative z-10 truncate">{item.label}</span>}
    </UiButton>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function Section({ title, children, collapsed }: { title: string; children: React.ReactNode; collapsed: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {collapsed ? (
        <div className="mx-auto my-1.5 h-px w-5 bg-line-strong/70" />
      ) : (
        <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-ink-3">{title}</div>
      )}
      {children}
    </div>
  );
}

function ThemeSwitch({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme();
  const options = [
    { value: 'light', icon: Sun, label: '浅色' },
    { value: 'dark', icon: Moon, label: '深色' },
    { value: 'system', icon: Monitor, label: '跟随系统' },
  ] as const;
  const activeValue = (theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system') as
    | 'light'
    | 'dark'
    | 'system';
  if (collapsed) {
    const current = options.find((o) => o.value === activeValue) ?? options[2];
    const next = options[(options.indexOf(current) + 1) % options.length];
    const Icon = current.icon;
    return (
      <Tooltip content={`主题：${current.label}`} side="right">
        <UiButton
          type="button"
          aria-label={`切换主题（当前：${current.label}）`}
          onClick={() => setTheme(next.value)}
          className="flex size-9 items-center justify-center rounded-lg text-ink-3 hover:bg-surface/60 hover:text-ink"
        >
          <Icon size={16} strokeWidth={1.75} />
        </UiButton>
      </Tooltip>
    );
  }
  return (
    <SegmentedControl
      label="主题"
      size="sm"
      value={activeValue}
      onChange={(next) => setTheme(next)}
      options={options.map((option) => ({
        value: option.value,
        hint: option.label,
        label: (
          <>
            <option.icon size={13} strokeWidth={1.9} aria-hidden="true" />
            <span className="sr-only">{option.label}</span>
          </>
        ),
      }))}
    />
  );
}

export function SidebarContent({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const profile = useActiveProfile();
  const profileName = profile?.name ?? null;

  return (
    <div className="flex h-full flex-col gap-3 px-2.5 pb-3 pt-3">
      <div className={cn('flex items-center', collapsed ? 'flex-col gap-2' : 'justify-between pl-1')}>
        <UiButton
          render={<Link href={profileName ? profilePath(profileName) : '/'} />}
          onClick={() => onNavigate?.()}
          aria-label="ProxyManager 首页"
          className="rounded-md outline-none"
        >
          {collapsed ? <LogoMark /> : <Wordmark />}
        </UiButton>
        <Tooltip content={collapsed ? '展开侧边栏' : '收起侧边栏'} side="right" shortcut={`${modKey()} \\`}>
          <UiButton
            type="button"
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            onClick={() => setUi((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))}
            className="hidden size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface/70 hover:text-ink lg:flex"
          >
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </UiButton>
        </Tooltip>
      </div>

      <UiButton
        type="button"
        aria-label="打开命令面板"
        onClick={() => {
          onNavigate?.();
          openPalette();
        }}
        className={cn(
          'flex h-8 items-center gap-2 rounded-lg border border-line bg-surface/70 text-[13px] text-ink-3 transition hover:border-line-strong hover:text-ink-2',
          collapsed ? 'mx-auto w-9 justify-center' : 'px-2.5',
        )}
      >
        <Search size={14} strokeWidth={1.9} />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">搜索或跳转…</span>
            <Kbd>{modKey()}K</Kbd>
          </>
        )}
      </UiButton>

      <nav aria-label="主导航" className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-2">
        <div className="flex flex-col gap-1.5">
          {!collapsed && <div className="px-2.5 pt-1 text-[11px] font-medium text-ink-3">当前配置</div>}
          <ProfileSwitcher collapsed={collapsed} />
          <div className={cn('mt-1 flex flex-col gap-0.5', collapsed && 'items-center')}>
            {PROFILE_NAV.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                href={hrefFor(item, profileName)}
                active={isActive(item, pathname, profileName)}
                collapsed={collapsed}
                profile={profile}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
        <Section title="资源库 · 所有配置共享" collapsed={collapsed}>
          <div className={cn('flex flex-col gap-0.5', collapsed && 'items-center')}>
            {LIBRARY_NAV.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                href={hrefFor(item, profileName)}
                active={isActive(item, pathname, profileName)}
                collapsed={collapsed}
                profile={profile}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </Section>
        <Section title="系统" collapsed={collapsed}>
          <div className={cn('flex flex-col gap-0.5', collapsed && 'items-center')}>
            {SYSTEM_NAV.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                href={hrefFor(item, profileName)}
                active={isActive(item, pathname, profileName)}
                collapsed={collapsed}
                profile={profile}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </Section>
      </nav>

      <div className={cn('flex flex-col gap-2', collapsed && 'items-center')}>
        <UiButton
          type="button"
          data-agent-hidden
          aria-label="打开 AI 助手"
          onClick={() => {
            onNavigate?.();
            openAssistant();
          }}
          className={cn(
            'group relative flex h-9 items-center gap-2 overflow-hidden rounded-lg text-[13px] font-medium text-ink transition',
            'border border-accent-line/70 bg-gradient-to-r from-accent-soft via-surface to-surface hover:border-accent/50',
            collapsed ? 'w-9 justify-center' : 'px-2.5',
          )}
        >
          <Sparkles size={15} strokeWidth={1.9} className="text-accent transition-transform group-hover:rotate-12" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">AI 助手</span>
              <Kbd className="bg-surface/80">{modKey()}J</Kbd>
            </>
          )}
        </UiButton>
        <div className={cn('flex items-center', collapsed ? 'justify-center' : 'justify-between pl-1')}>
          {!collapsed && <span className="text-[11px] text-ink-4">v2 · Transit</span>}
          <ThemeSwitch collapsed={collapsed} />
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-dvh shrink-0 transition-[width] duration-300 ease-[var(--ease-out-expo)] lg:block',
        collapsed ? 'w-[64px]' : 'w-[248px]',
      )}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}
