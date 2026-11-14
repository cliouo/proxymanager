'use client';

import { AuthGate } from '@/ui/shell/gates';

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
