'use client';

import { Suspense } from 'react';
import { RulesPage } from '@/ui/features/rules/rules-page';

export default function Rules() {
  return (
    <Suspense fallback={null}>
      <RulesPage />
    </Suspense>
  );
}
