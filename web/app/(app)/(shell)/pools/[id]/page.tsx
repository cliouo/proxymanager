'use client';

import { Suspense } from 'react';
import { PoolDetail } from '@/ui/features/sources/pool-detail';

export default function PoolDetailPage() {
  return (
    <Suspense>
      <PoolDetail />
    </Suspense>
  );
}
