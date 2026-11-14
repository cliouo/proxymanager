'use client';

import { AppShell } from '@/ui/shell/app-shell';
import { SetupGate } from '@/ui/shell/gates';

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <SetupGate>
      <AppShell>{children}</AppShell>
    </SetupGate>
  );
}
