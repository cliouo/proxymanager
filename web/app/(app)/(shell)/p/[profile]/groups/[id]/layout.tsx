import type { ReactNode } from 'react';

// Client-rendered detail page: render the shell statically on first visit
// instead of on every navigation (see p/[profile]/layout.tsx).
export function generateStaticParams() {
  return [];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
