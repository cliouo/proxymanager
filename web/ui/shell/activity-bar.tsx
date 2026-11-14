'use client';

import { useEffect, useState } from 'react';
import { useNetworkBusy } from '@/ui/data/activity';

/**
 * Hairline progress bar along the top of the main panel while admin-API
 * requests are in flight. It waits a beat before appearing so fast responses
 * never flash it, creeps toward the end while busy, then completes and fades.
 * On a slow backend this is the difference between "working" and "frozen".
 */
export function ActivityBar() {
  const busy = useNetworkBusy();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!busy) {
      const finish = setTimeout(() => setProgress((p) => (p > 0 ? 1 : 0)), 0);
      const hide = setTimeout(() => setVisible(false), 320);
      const reset = setTimeout(() => setProgress(0), 700);
      return () => {
        clearTimeout(finish);
        clearTimeout(hide);
        clearTimeout(reset);
      };
    }
    const start = setTimeout(() => {
      setVisible(true);
      setProgress((p) => (p === 0 || p === 1 ? 0.14 : p));
    }, 160);
    const creep = setInterval(() => {
      setProgress((p) => (p > 0 && p < 1 ? p + (0.94 - p) * 0.09 : p));
    }, 200);
    return () => {
      clearTimeout(start);
      clearInterval(creep);
    };
  }, [busy]);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] transition-opacity duration-300"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div
        className="relative h-full origin-left bg-accent transition-transform duration-300 ease-out"
        style={{ transform: `scaleX(${progress})` }}
      >
        <span className="absolute -top-px right-0 h-1 w-16 rounded-full bg-accent opacity-60 blur-[3px]" />
      </div>
    </div>
  );
}
