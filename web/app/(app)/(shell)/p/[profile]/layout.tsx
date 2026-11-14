import type { ReactNode } from 'react';
import { ProfileLayout } from '@/ui/shell/profile-layout';

// The page shell is client-rendered; the profile name only matters in the
// browser. An empty list makes every profile path static on first visit, so
// navigation and Link prefetch don't wait on a server render per click.
export function generateStaticParams() {
  return [];
}

export default function Layout({ children }: { children: ReactNode }) {
  return <ProfileLayout>{children}</ProfileLayout>;
}
