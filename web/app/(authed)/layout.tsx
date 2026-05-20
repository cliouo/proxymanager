'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { getAdminKey } from '@/lib/client/auth-storage';

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
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
      <main className="min-h-screen flex items-center justify-center text-[var(--color-muted)]">
        Loading…
      </main>
    );
  }

  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <main className="flex-1 min-w-0 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
