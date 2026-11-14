'use client';

import { Suspense } from 'react';
import { SourcesIndex } from '@/ui/features/sources/sources-index';

export default function SourcesPage() {
  return (
    <Suspense>
      <SourcesIndex />
    </Suspense>
  );
}
