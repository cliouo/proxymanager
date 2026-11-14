'use client';

import { useEffect, useMemo, useState } from 'react';
import { codeFromFlag, detectRegion, regionByCode, stripFlags } from '@/lib/proxies/regions';
import { cn } from '@/ui/lib/cn';
import { isFlagSupported } from './flag-support';

export interface NodeInfo {
  name: string;
  region: string | null;
  flag: string | null;
  label: string;
  zh: string | null;
}

export function describeNode(name: string): NodeInfo {
  const region = detectRegion(name);
  const meta = region ? regionByCode(region) : undefined;
  const explicitFlag = codeFromFlag(name);
  const label = stripFlags(name) || name;
  return {
    name,
    region,
    flag: meta?.emoji ?? (explicitFlag ? null : null),
    label,
    zh: meta?.zh ?? null,
  };
}

export function Flag({ region, className, size = 15 }: { region: string | null; className?: string; size?: number }) {
  const meta = region ? regionByCode(region) : undefined;
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    if (meta) setSupported(isFlagSupported(meta.emoji));
  }, [meta]);
  if (meta && !supported) {
    return (
      <span
        aria-label={meta.zh}
        title={meta.zh}
        style={{ height: size, minWidth: size + 5, fontSize: Math.max(8, size * 0.56) }}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-[4px] border border-line bg-surface-2 px-0.5 font-mono font-semibold leading-none tracking-tight text-ink-2',
          className,
        )}
      >
        {meta.code}
      </span>
    );
  }
  if (!meta) {
    return (
      <span
        aria-hidden
        style={{ width: size + 3, height: size }}
        className={cn('inline-flex shrink-0 items-center justify-center rounded-[4px] bg-surface-3 text-[9px] text-ink-4', className)}
      >
        ·
      </span>
    );
  }
  return (
    <span aria-label={meta.zh} title={meta.zh} className={cn('inline-block shrink-0 leading-none', className)} style={{ fontSize: size }}>
      {meta.emoji}
    </span>
  );
}

/** A node name with its flag pulled out front (never duplicated). */
export function NodeName({ name, className, mono }: { name: string; className?: string; mono?: boolean }) {
  const info = useMemo(() => describeNode(name), [name]);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={name}>
      <Flag region={info.region} />
      <span className={cn('truncate', mono && 'font-mono text-[12px]')}>{info.label}</span>
    </span>
  );
}

export interface RegionCount {
  region: string | null;
  zh: string;
  count: number;
}

export function countRegions(names: string[]): RegionCount[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const region = detectRegion(name) ?? '?';
    counts.set(region, (counts.get(region) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([region, count]) => ({
      region: region === '?' ? null : region,
      zh: region === '?' ? '其他' : (regionByCode(region)?.zh ?? region),
      count,
    }))
    .sort((a, b) => (a.region === null ? 1 : b.region === null ? -1 : b.count - a.count));
}

/** Compact flag cluster with counts, e.g. 🇭🇰 6 · 🇯🇵 5 · 🇺🇸 4 … */
export function RegionStrip({
  names,
  max = 6,
  className,
}: {
  names: string[];
  max?: number;
  className?: string;
}) {
  const regions = useMemo(() => countRegions(names), [names]);
  if (regions.length === 0) return null;
  const shown = regions.slice(0, max);
  const rest = regions.slice(max).reduce((sum, r) => sum + r.count, 0);
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {shown.map((r) => (
        <span
          key={r.region ?? 'other'}
          title={`${r.zh} · ${r.count} 个节点`}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface px-1.5 text-[11px] text-ink-2"
        >
          <Flag region={r.region} size={13} />
          <span className="tnum font-medium">{r.count}</span>
        </span>
      ))}
      {rest > 0 && (
        <span className="inline-flex h-6 items-center rounded-full px-1.5 text-[11px] text-ink-3">+{rest}</span>
      )}
    </div>
  );
}
