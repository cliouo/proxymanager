'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useProfiles } from '@/ui/data/hooks';
import { lastProfileName, profilePath } from '@/ui/shell/scope';
import { BootScreen } from '@/ui/shell/gates';

export default function Home() {
  const router = useRouter();
  const { data: profiles } = useProfiles();
  useEffect(() => {
    if (!profiles?.length) return;
    const last = lastProfileName();
    const target =
      profiles.find((p) => p.name === last) ??
      profiles.find((p) => p.name === 'default') ??
      profiles.find((p) => p.kind !== 'template') ??
      profiles[0];
    router.replace(profilePath(target.name));
  }, [profiles, router]);
  return <BootScreen label="正在打开配置" />;
}
