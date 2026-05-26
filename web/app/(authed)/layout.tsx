'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { RouteProgress } from '@/components/RouteProgress';
import { Sidebar } from '@/components/Sidebar';
import { getAdminKey } from '@/lib/client/auth-storage';

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getAdminKey()) {
      const next = window.location.pathname + window.location.search;
      window.location.href = `/login?next=${encodeURIComponent(next)}`;
      return;
    }
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
        <span
          className="pm-pulse font-serif text-[20px] font-medium tracking-[-0.01em] text-[var(--color-muted-strong)]"
          style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
        >
          正在准备工作台 …
        </span>
      </main>
    );
  }

  return (
    <div className="min-h-screen flex bg-[var(--color-bg)]">
      <RouteProgress />
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <main className="flex-1 min-w-0 overflow-auto px-8 pt-8 pb-12">
          <div key={pathname} className="mx-auto max-w-[1200px] pm-reveal">
            {children}
          </div>
        </main>
      </div>
      <AssistantPanel />
    </div>
  );
}
