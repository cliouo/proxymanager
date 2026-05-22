'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * 顶部 2px 陶土进度条：路由 pathname 变化时短暂闪过 800ms。
 * 给"我点了链接，浏览器在干活"提供视觉反馈。
 */
export function RouteProgress() {
  const pathname = usePathname();
  const [tick, setTick] = useState<number | null>(null);

  useEffect(() => {
    // 第一次挂载不放，避免页面初始就闪
    if (tick === null) {
      setTick(0);
      return;
    }
    setTick((t) => (t ?? 0) + 1);
    const id = window.setTimeout(() => setTick(0), 800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (!tick) return null;
  return <div key={tick} className="pm-route-progress" aria-hidden />;
}
