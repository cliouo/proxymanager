'use client';

import { Suspense } from 'react';
import { DevicesPage } from '@/ui/features/devices/devices-page';

export default function DevicesRoute() {
  return (
    <Suspense fallback={null}>
      <DevicesPage />
    </Suspense>
  );
}
