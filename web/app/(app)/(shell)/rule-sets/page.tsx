'use client';

import { Suspense } from 'react';
import { RuleSetsView } from '@/ui/features/rule-sets/rule-sets-view';

export default function RuleSetsPage() {
  return (
    <Suspense fallback={null}>
      <RuleSetsView />
    </Suspense>
  );
}
