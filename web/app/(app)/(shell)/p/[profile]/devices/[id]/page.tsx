'use client';

import { useParams } from 'next/navigation';
import { DeviceEditor } from '@/ui/features/devices/device-editor';

export default function DeviceRoute() {
  const params = useParams<{ id: string }>();
  return <DeviceEditor deviceId={params.id} />;
}
