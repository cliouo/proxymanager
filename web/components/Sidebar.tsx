'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clearAdminKey } from '@/lib/client/auth-storage';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/base', label: 'Base config' },
  { href: '/rules', label: 'Rules' },
  { href: '/rule-sets', label: 'Rule sets' },
  { href: '/subscriptions', label: 'Subscriptions' },
  { href: '/history', label: 'History' },
  { href: '/docs', label: 'API docs', external: true },
];

export function Sidebar() {
  const pathname = usePathname();

  function signOut() {
    clearAdminKey();
    window.location.href = '/login';
  }

  return (
    <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col">
      <div className="px-4 py-4 border-b border-[var(--color-border)]">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          ProxyManager
        </Link>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {NAV.map((item) => {
          const active = !item.external && (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                active
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                  : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
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
