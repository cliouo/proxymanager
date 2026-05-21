'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';

const PRIMARY_NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/base', label: 'Base config' },
  { href: '/rules', label: 'Rules' },
  { href: '/rule-sets', label: 'Rule sets' },
  { href: '/subscriptions', label: 'Subscriptions' },
  { href: '/history', label: 'History' },
];

const FOOTER_NAV = [{ href: '/docs', label: 'API docs', external: true }];

interface ScenarioDescriptor {
  id: string;
  title: string;
  navHref?: string;
}

export function Sidebar() {
  const pathname = usePathname();
  const [scenarios, setScenarios] = useState<ScenarioDescriptor[]>([]);

  // Pulled at mount — scenarios are server-defined, but the list rarely
  // changes during a session so the small extra request is cheap.
  useEffect(() => {
    api<{ data: ScenarioDescriptor[] }>('/api/v1/scenarios')
      .then((r) => setScenarios(r.data))
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
    <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col">
      <div className="px-4 py-4 border-b border-[var(--color-border)]">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          ProxyManager
        </Link>
      </div>
      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        {PRIMARY_NAV.map((item) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            label={item.label}
            active={isActive(item.href)}
          />
        ))}

        <div className="pt-3 mt-2 border-t border-[var(--color-border)]/60">
          <SidebarLink
            href="/scenarios"
            label="Scenarios"
            active={
              pathname === '/scenarios' ||
              (pathname.startsWith('/scenarios/') &&
                !scenarios.some((s) => s.navHref === pathname))
            }
          />
          {scenarios.map((s) =>
            s.navHref ? (
              <SidebarLink
                key={s.id}
                href={s.navHref}
                label={s.title}
                active={pathname === s.navHref}
                indent
              />
            ) : null,
          )}
        </div>

        <div className="pt-3 mt-2 border-t border-[var(--color-border)]/60">
          {FOOTER_NAV.map((item) => (
            <SidebarLink key={item.href} href={item.href} label={item.label} active={false} />
          ))}
        </div>
      </nav>
      <div className="p-3 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={signOut}
          className="w-full text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] text-left"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

function SidebarLink({
  href,
  label,
  active,
  indent,
}: {
  href: string;
  label: string;
  active: boolean;
  indent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`block rounded-md py-1.5 text-sm transition-colors ${
        indent ? 'pl-6 pr-3 text-xs' : 'px-3'
      } ${
        active
          ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
          : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]'
      }`}
    >
      {label}
    </Link>
  );
}
