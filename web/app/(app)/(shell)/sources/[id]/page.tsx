'use client';

import { Suspense } from 'react';
import { SourceDetail } from '@/ui/features/sources/source-detail';

export default function SourceDetailPage() {
  return (
    <Suspense>
      <SourceDetail />
    </Suspense>
  );
}
