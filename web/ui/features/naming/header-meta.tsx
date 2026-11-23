'use client';

import { Monogram } from '@/ui/primitives';

export function NamingHeaderMeta({ label, kindLabel, nodeCount, infoFiltered }: {
  label: string; kindLabel: string; nodeCount: number; infoFiltered: number;
}) {
  return <>
    <Monogram name={label} size={18} />
    <span className="min-w-0 max-w-full truncate font-medium text-ink-2" title={label}>{label}</span>
    <span className="shrink-0 whitespace-nowrap">{kindLabel}</span>
    <span className="tnum shrink-0 whitespace-nowrap">输入 {nodeCount} 个节点</span>
    {infoFiltered > 0 && <span>{infoFiltered} 个信息节点（剩余流量、到期等）已过滤</span>}
  </>;
}
