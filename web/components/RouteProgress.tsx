'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * 顶部 2px 进度条：站内链接点击时立即出现,pathname 变化后收尾。
 * 给"我点了链接，浏览器在干活"提供视觉反馈。
 */
export function RouteProgress() {
  const pathname = usePathname();
  const [tick, setTick] = useState<number | null>(null);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    function start() {
      setTick((t) => (t ?? 0) + 1);
    }

    function onClick(e: MouseEvent) {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const target = e.target as Element | null;
      const link = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!link) return;
      const url = new URL(link.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      start();
    }

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    if (lastPath.current === null) {
      lastPath.current = pathname;
      return;
    }
    lastPath.current = pathname;
    setTick((t) => (t ?? 0) + 1);
    const id = window.setTimeout(() => setTick(0), 800);
    return () => window.clearTimeout(id);
  }, [pathname]);

  useEffect(() => {
    if (!tick) return;
    const id = window.setTimeout(() => setTick(0), 1200);
    return () => window.clearTimeout(id);
  }, [tick]);

  if (!tick) return null;
  return <div key={tick} className="pm-route-progress" aria-hidden />;
}
