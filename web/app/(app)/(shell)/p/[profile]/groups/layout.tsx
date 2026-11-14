'use client';

import { Suspense } from 'react';
import { GroupsWorkspace } from '@/ui/features/groups/workspace';

export default function GroupsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <GroupsWorkspace>{children}</GroupsWorkspace>
    </Suspense>
  );
}
