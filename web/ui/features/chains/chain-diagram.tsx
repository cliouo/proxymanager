'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { PolicyChip, useLineColors } from '@/ui/viz/lines';
import { NodeName } from '@/ui/viz/nodes';

/** A station label: a node (flag + name) or a group (its coloured line chip). */
export function Endpoint({ name, isGroup, meta }: { name: string; isGroup?: boolean; meta?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {isGroup ? (
        <PolicyChip policy={name} size="sm" className="max-w-full self-start" />
      ) : (
        <NodeName name={name} className="text-sm font-medium text-ink" />
      )}
      {meta && <span className="truncate text-2xs text-ink-3">{meta}</span>}
    </span>
  );
}

/**
 * A tiny transit map: the chain's own line (its policy-group colour) runs from
 * the front station (hollow, interchange) to the backend terminus (filled).
 * Dots travel along it in the direction traffic flows.
 */
export function ChainDiagram({
  lineName,
  front,
  backend,
}: {
  lineName: string;
  front: ReactNode;
  backend: ReactNode;
}) {
  const { color } = useLineColors();
  const c = lineName ? color(lineName) : 'var(--line-strong)';
  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-5" aria-hidden>
        <div className="absolute inset-x-2 top-1/2 h-[5px] -translate-y-1/2 rounded-full" style={{ background: c }} />
        <svg className="absolute left-2 top-1/2 h-[5px] w-[calc(100%-16px)] -translate-y-1/2 overflow-visible">
          <line
            x1="0"
            y1="2.5"
            x2="100%"
            y2="2.5"
            stroke="var(--surface)"
            strokeOpacity="0.9"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="1.5 10.5"
            className="animate-[flow_1.2s_linear_infinite]"
          />
        </svg>
        <span
          className="absolute left-0 top-1/2 size-[18px] -translate-y-1/2 rounded-full border-4 bg-surface"
          style={{ borderColor: c }}
        />
        <span
          className="absolute left-1/2 top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-surface"
          style={{ borderColor: c, color: c }}
        >
          <ChevronRight size={12} strokeWidth={2.75} />
        </span>
        <span
          className="absolute right-0 top-1/2 size-[18px] -translate-y-1/2 rounded-full border-[3px] border-surface"
          style={{ background: c, boxShadow: `0 0 0 2px ${c}` }}
        />
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 max-w-[48%] flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">前置</span>
          {front}
        </div>
        <div className="flex min-w-0 max-w-[48%] flex-col items-end gap-1 text-right [&>span]:items-end">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">落地</span>
          {backend}
        </div>
      </div>
    </div>
  );
}
