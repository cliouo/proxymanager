'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/ui/lib/cn';

export interface FlowNode {
  id: string;
  label: string;
  sublabel?: string;
  color?: string;
  icon?: ReactNode;
}

export interface FlowLink {
  from: string;
  to: string;
  value: number;
}

interface LaidNode extends FlowNode {
  y: number;
  h: number;
  value: number;
}

interface LaidLink extends FlowLink {
  y0: number;
  y1: number;
  thickness: number;
  color: string;
}

const LABEL_LEFT = 168;
const LABEL_RIGHT = 176;
const BAR = 6;
const GAP = 10;
const MIN_NODE = 16;

function layout(
  left: FlowNode[],
  right: FlowNode[],
  links: FlowLink[],
  height: number,
): { leftNodes: LaidNode[]; rightNodes: LaidNode[]; laidLinks: LaidLink[] } {
  const leftValue = new Map<string, number>();
  const rightValue = new Map<string, number>();
  for (const link of links) {
    leftValue.set(link.from, (leftValue.get(link.from) ?? 0) + link.value);
    rightValue.set(link.to, (rightValue.get(link.to) ?? 0) + link.value);
  }

  const column = (nodes: FlowNode[], values: Map<string, number>): LaidNode[] => {
    const present = nodes.filter((n) => (values.get(n.id) ?? 0) > 0);
    const total = present.reduce((sum, n) => sum + (values.get(n.id) ?? 0), 0);
    const available = Math.max(40, height - GAP * Math.max(0, present.length - 1));
    // Reserve the minimum height first, then share the rest proportionally.
    const flexible = Math.max(0, available - MIN_NODE * present.length);
    let y = 0;
    return present.map((node) => {
      const value = values.get(node.id) ?? 0;
      const h = MIN_NODE + (total > 0 ? (value / total) * flexible : 0);
      const laid = { ...node, value, y, h };
      y += h + GAP;
      return laid;
    });
  };

  const leftNodes = column(left, leftValue);
  const rightNodes = column(right, rightValue);
  const leftIndex = new Map(leftNodes.map((n, i) => [n.id, i]));
  const rightIndex = new Map(rightNodes.map((n, i) => [n.id, i]));
  const leftById = new Map(leftNodes.map((n) => [n.id, n]));
  const rightById = new Map(rightNodes.map((n) => [n.id, n]));

  // Stack link ends to minimise crossings: at the source, order by target position; at the target, by source position.
  const leftCursor = new Map(leftNodes.map((n) => [n.id, n.y]));
  const rightCursor = new Map(rightNodes.map((n) => [n.id, n.y]));
  const valid = links.filter((l) => leftById.has(l.from) && rightById.has(l.to) && l.value > 0);
  const bySource = [...valid].sort(
    (a, b) => (leftIndex.get(a.from)! - leftIndex.get(b.from)!) || (rightIndex.get(a.to)! - rightIndex.get(b.to)!),
  );
  const startY = new Map<FlowLink, number>();
  const thicknessOf = new Map<FlowLink, number>();
  for (const link of bySource) {
    const source = leftById.get(link.from)!;
    const thickness = (link.value / source.value) * source.h;
    thicknessOf.set(link, thickness);
    startY.set(link, leftCursor.get(link.from)!);
    leftCursor.set(link.from, leftCursor.get(link.from)! + thickness);
  }
  const byTarget = [...valid].sort(
    (a, b) => (rightIndex.get(a.to)! - rightIndex.get(b.to)!) || (leftIndex.get(a.from)! - leftIndex.get(b.from)!),
  );
  const laidLinks: LaidLink[] = byTarget.map((link) => {
    const target = rightById.get(link.to)!;
    const targetThickness = (link.value / target.value) * target.h;
    const y1 = rightCursor.get(link.to)!;
    rightCursor.set(link.to, y1 + targetThickness);
    return {
      ...link,
      y0: startY.get(link)!,
      y1,
      thickness: thicknessOf.get(link)!,
      color: target.color ?? 'var(--ink-3)',
      // carry the target thickness through the path's end (can differ from source side)
      targetThickness,
    } as LaidLink & { targetThickness: number };
  });
  return { leftNodes, rightNodes, laidLinks };
}

export function FlowMap({
  left,
  right,
  links,
  height = 360,
  onLeftClick,
  onRightClick,
  unit = '条',
  className,
}: {
  left: FlowNode[];
  right: FlowNode[];
  links: FlowLink[];
  height?: number;
  onLeftClick?: (id: string) => void;
  onRightClick?: (id: string) => void;
  unit?: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ side: 'left' | 'right'; id: string } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { leftNodes, rightNodes, laidLinks } = useMemo(() => layout(left, right, links, height), [left, right, links, height]);
  const x0 = LABEL_LEFT;
  const x1 = Math.max(x0 + 120, width - LABEL_RIGHT);
  const mid = (x0 + BAR + x1) / 2;

  const active = (link: FlowLink) =>
    !hover || (hover.side === 'left' ? link.from === hover.id : link.to === hover.id);
  const nodeActive = (side: 'left' | 'right', id: string) => {
    if (!hover) return true;
    if (hover.side === side) return hover.id === id;
    return laidLinks.some((l) => (side === 'left' ? l.from === id && l.to === hover.id : l.to === id && l.from === hover.id));
  };

  return (
    <div ref={hostRef} className={cn('relative w-full select-none', className)} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="overflow-visible" role="img" aria-label="规则分流图">
          <g>
            {laidLinks.map((link, index) => {
              const t1 = (link as LaidLink & { targetThickness: number }).targetThickness;
              const sx = x0 + BAR;
              const ex = x1;
              const path = [
                `M${sx},${link.y0}`,
                `C${mid},${link.y0} ${mid},${link.y1} ${ex},${link.y1}`,
                `L${ex},${link.y1 + t1}`,
                `C${mid},${link.y1 + t1} ${mid},${link.y0 + link.thickness} ${sx},${link.y0 + link.thickness}`,
                'Z',
              ].join(' ');
              const on = active(link);
              return (
                <path
                  key={`${link.from}-${link.to}-${index}`}
                  d={path}
                  fill={link.color}
                  className="transition-[fill-opacity] duration-200"
                  style={{
                    fillOpacity: on ? (hover ? 0.42 : 0.24) : 0.05,
                    animation: `fade-in 0.6s var(--ease-out-expo) both`,
                    animationDelay: `${0.1 + index * 0.025}s`,
                  }}
                />
              );
            })}
          </g>
          {leftNodes.map((node) => {
            const on = nodeActive('left', node.id);
            return (
              <g
                key={node.id}
                className={cn('cursor-default transition-opacity duration-200', onLeftClick && 'cursor-pointer')}
                style={{ opacity: on ? 1 : 0.35 }}
                onMouseEnter={() => setHover({ side: 'left', id: node.id })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onLeftClick?.(node.id)}
              >
                <rect x={x0} y={node.y} width={BAR} height={node.h} rx={2} fill="var(--ink)" fillOpacity={0.78} />
                <foreignObject x={0} y={node.y + node.h / 2 - 18} width={x0 - 10} height={36}>
                  {node.h >= 30 ? (
                    <div className="flex h-9 flex-col items-end justify-center text-right leading-tight">
                      <span className="max-w-full truncate text-[12.5px] font-medium text-ink">{node.label}</span>
                      <span className="tnum text-[11px] text-ink-3">
                        {node.sublabel ? `${node.sublabel} · ` : ''}
                        {node.value} {unit}
                      </span>
                    </div>
                  ) : (
                    <div className="flex h-9 items-center justify-end gap-1.5 text-right leading-none">
                      {node.sublabel && (
                        <span className="rounded border border-line px-1 py-px text-[10px] text-ink-3">{node.sublabel}</span>
                      )}
                      <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{node.label}</span>
                      <span className="tnum text-[11px] text-ink-3">{node.value}</span>
                    </div>
                  )}
                </foreignObject>
              </g>
            );
          })}
          {rightNodes.map((node) => {
            const on = nodeActive('right', node.id);
            return (
              <g
                key={node.id}
                className={cn('transition-opacity duration-200', onRightClick && 'cursor-pointer')}
                style={{ opacity: on ? 1 : 0.35 }}
                onMouseEnter={() => setHover({ side: 'right', id: node.id })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onRightClick?.(node.id)}
              >
                <rect x={x1} y={node.y} width={BAR} height={node.h} rx={2} fill={node.color ?? 'var(--ink-3)'} />
                <foreignObject x={x1 + BAR + 10} y={node.y + node.h / 2 - 18} width={LABEL_RIGHT - 16} height={36}>
                  {node.h >= 30 ? (
                    <div className="flex h-9 flex-col justify-center leading-tight">
                      <span className="max-w-full truncate text-[12.5px] font-medium text-ink">{node.label}</span>
                      <span className="tnum text-[11px] text-ink-3">
                        {node.value} {unit}
                        {node.sublabel ? ` · ${node.sublabel}` : ''}
                      </span>
                    </div>
                  ) : (
                    <div className="flex h-9 items-center gap-1.5 leading-none">
                      <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{node.label}</span>
                      <span className="tnum text-[11px] text-ink-3">{node.value}</span>
                      {node.sublabel && <span className="text-[11px] text-ink-4">{node.sublabel}</span>}
                    </div>
                  )}
                </foreignObject>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
