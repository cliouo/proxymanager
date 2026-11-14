'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Pools are listed on 节点来源 → 聚合订阅. */
export default function PoolsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/sources?tab=pools');
  }, [router]);
  return null;
}
