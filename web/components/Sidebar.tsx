'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';

/**
 * The IA splits into three groups (E4):
 *   - 总览                      single entry point
 *   - 资源 (Resources)           reusable inputs that flow INTO the config
 *                              (订阅源 → proxies, 聚合订阅 → 一个 sub bundle,
 *                               规则集 → rule-providers)
 *   - 应用 (Application)         what's actually rendered: policy (策略组 +
 *                              链式代理 + 规则), the skeleton, the final yaml.
 *   - 系统 (System)              operational/admin views.
 *
 * Auto-discovered scenarios + the docs link live under the FOOTER sections.
 */
const OVERVIEW_NAV: { href: string; label: string; icon: string }[] = [
  { href: '/', label: '总览', icon: '◐' },
];

const RESOURCE_NAV: { href: string; label: string; icon: string }[] = [
  { href: '/subscriptions', label: '订阅源', icon: '⇣' },
  { href: '/collections', label: '聚合订阅', icon: '⊞' },
  { href: '/rule-sets', label: '规则集', icon: '⊟' },
];

const APP_NAV: { href: string; label: string; icon: string }[] = [
  { href: '/proxy-groups', label: '策略组', icon: '⊕' },
  { href: '/scenarios/chained-proxy', label: '链式代理', icon: '↻' },
  { href: '/scenarios/rule-anchor-append', label: '规则', icon: '≡' },
  { href: '/base', label: '结构骨架', icon: '⌬' },
  { href: '/config', label: '最终配置', icon: '◉' },
];

const SYSTEM_NAV: { href: string; label: string; icon: string }[] = [
  { href: '/history', label: '操作历史', icon: '⟲' },
  { href: '/docs', label: 'API 文档', icon: '❡' },
];

// Promoted into the dedicated CONFIG_NAV slot above, so they're hidden from
// the auto "场景" list below.
const PROMOTED_SCENARIOS = new Set(['rule-anchor-append', 'chained-proxy']);


interface ScenarioDescriptor {
  id: string;
  title: string;
  navHref?: string;
}

const SCENARIO_LABEL_OVERRIDES: Record<string, string> = {
  'rule-anchor-append': '规则编辑',
  'chained-proxy': '链式代理',
  'dev-echo': 'Echo (调试)',
};

export function Sidebar() {
  const pathname = usePathname();
  const [scenarios, setScenarios] = useState<ScenarioDescriptor[]>([]);
  const [buildId, setBuildId] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: ScenarioDescriptor[] }>('/api/v1/scenarios')
      .then((r) => setScenarios(r.data))
      .catch(() => undefined);
    api<{ data: { buildId: string | null } }>('/api/v1/meta')
      .then((r) => setBuildId(r.data.buildId))
      .catch(() => undefined);
  }, []);

  function signOut() {
    clearAdminKey();
    window.location.href = '/login';
  }

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <aside className="w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-sunk)] flex flex-col">
      <div className="px-5 py-5">
        <Link href="/" className="group flex flex-col leading-tight">
          <span
            className="font-serif text-[22px] font-medium tracking-[-0.015em] text-[var(--color-ink)] transition-colors group-hover:text-[var(--color-primary)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            ProxyManager
          </span>
          <span className="text-[10px] tracking-[0.08em] uppercase text-[var(--color-muted)] mt-0.5 flex items-baseline gap-1.5">
            代理订阅管家
            {buildId && (
              <span className="font-mono normal-case tracking-normal text-[var(--color-muted-strong)]">
                · {buildId.slice(0, 7)}
              </span>
            )}
          </span>
        </Link>
      </div>

      <nav className="flex-1 px-3 pb-3 space-y-0.5 overflow-y-auto">
        {OVERVIEW_NAV.map((item) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(item.href)}
          />
        ))}

        <SectionLabel>资源</SectionLabel>
        {RESOURCE_NAV.map((item) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(item.href)}
          />
        ))}

        <SectionLabel>应用</SectionLabel>
        {APP_NAV.map((item) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(item.href)}
          />
        ))}

        <SectionLabel>系统</SectionLabel>
        {SYSTEM_NAV.map((item) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(item.href)}
          />
        ))}

        <SectionLabel>更多场景</SectionLabel>
        <SidebarLink
          href="/scenarios"
          label="全部场景"
          icon="✦"
          active={
            pathname === '/scenarios' ||
            (pathname.startsWith('/scenarios/') &&
              !scenarios.some((s) => s.navHref === pathname))
          }
        />
        {scenarios.map((s) =>
          s.navHref && !PROMOTED_SCENARIOS.has(s.id) ? (
            <SidebarLink
              key={s.id}
              href={s.navHref}
              label={SCENARIO_LABEL_OVERRIDES[s.id] ?? s.title}
              active={pathname === s.navHref}
              indent
            />
          ) : null,
        )}
      </nav>

      <div className="p-3 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={signOut}
          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] transition-colors text-left active:scale-[0.98]"
        >
          <span className="text-[14px] inline-flex w-4 justify-center">⏻</span>
          <span>退出登录</span>
        </button>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-5 pb-1 px-2.5 text-[11px] uppercase tracking-[0.08em] text-[var(--color-muted)] font-semibold">
      {children}
    </div>
  );
}

function SidebarLink({
  href,
  label,
  icon,
  active,
  indent,
}: {
  href: string;
  label: string;
  icon?: string;
  active: boolean;
  indent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`relative flex items-center gap-2.5 rounded-lg py-1.5 text-[13px] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] ${
        indent ? 'pl-9 pr-2.5 text-[12px]' : 'px-2.5'
      } ${
        active
          ? 'bg-[var(--color-surface)] text-[var(--color-fg)] font-medium'
          : 'text-[var(--color-fg-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]'
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-[var(--color-primary)]" />
      )}
      {icon && !indent && (
        <span
          className={`inline-flex h-4 w-4 items-center justify-center text-[13px] ${
            active ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted)]'
          }`}
        >
          {icon}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
    </Link>
  );
}
