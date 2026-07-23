'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Backward-compat redirect. Tailscale 是设备级功能,跨设备状态与迁移提示
 * 并入「设备」页(/devices),逐台编辑在设备详情页的 Tailscale 卡;
 * 本路径保留给旧链接与场景注册表,tailscale 场景后端不受影响。
 */
export default function TailscaleRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/devices');
  }, [router]);
  return <main className="p-8 text-sm text-[var(--color-muted)]">正在跳转到「设备」…</main>;
}
