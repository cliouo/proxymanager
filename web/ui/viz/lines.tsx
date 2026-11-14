'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Ban, CornerDownRight, Equal, Gauge, Layers, ShieldCheck, Shuffle } from 'lucide-react';
import { cn } from '@/ui/lib/cn';

/**
 * Transit lines. Every policy group of the active profile gets a stable,
 * distinct colour — the same colour everywhere (rules rail, group list,
 * flow map, chips) so you can follow a "line" across the whole app.
 */

export const LINE_COUNT = 10;
export const lineVar = (index: number) => `var(--l-${(index % LINE_COUNT) + 1})`;

export const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'] as const;

export const BUILTIN_LABEL: Record<string, string> = {
  DIRECT: '直连',
  REJECT: '拦截',
  'REJECT-DROP': '静默丢弃',
  PASS: '跳过',
  COMPATIBLE: '兼容',
};

export function isBuiltinPolicy(name: string): boolean {
  return (BUILTIN_POLICIES as readonly string[]).includes(name);
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Assign colours in rank order: each group prefers hash(name) % N, and probes
 * forward to the next free colour so the first N groups never collide.
 */
export function assignLineColors(groupNames: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const taken = new Set<number>();
  for (const name of groupNames) {
    let index = hash(name) % LINE_COUNT;
    if (taken.size < LINE_COUNT) {
      while (taken.has(index)) index = (index + 1) % LINE_COUNT;
    }
    taken.add(index);
    map.set(name, lineVar(index));
  }
  return map;
}

export function policyColor(map: Map<string, string>, policy: string): string {
  if (policy === 'DIRECT' || policy === 'PASS' || policy === 'COMPATIBLE') return 'var(--l-direct)';
  if (policy === 'REJECT' || policy === 'REJECT-DROP') return 'var(--l-reject)';
  return map.get(policy) ?? 'var(--ink-4)';
}

const LineContext = createContext<Map<string, string>>(new Map());

export function LineColorProvider({ groupNames, children }: { groupNames: string[]; children: ReactNode }) {
  const key = groupNames.join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const map = useMemo(() => assignLineColors(groupNames), [key]);
  return <LineContext.Provider value={map}>{children}</LineContext.Provider>;
}

export function useLineColors() {
  const map = useContext(LineContext);
  return useMemo(
    () => ({
      map,
      color: (policy: string) => policyColor(map, policy),
    }),
    [map],
  );
}

/* ─── chips ──────────────────────────────────────────────────────────── */

export function LineDot({ color, size = 8, className, hollow }: { color: string; size?: number; className?: string; hollow?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={
        hollow
          ? { width: size, height: size, boxShadow: `inset 0 0 0 2px ${color}` }
          : { width: size, height: size, background: color }
      }
    />
  );
}

/** A policy target rendered as a coloured line chip. */
export function PolicyChip({
  policy,
  size = 'md',
  className,
  muted,
}: {
  policy: string;
  size?: 'sm' | 'md';
  className?: string;
  muted?: boolean;
}) {
  const { color } = useLineColors();
  const c = color(policy);
  const builtin = isBuiltinPolicy(policy);
  return (
    <span
      title={builtin ? `${policy} · ${BUILTIN_LABEL[policy]}` : policy}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium',
        size === 'sm' ? 'h-5 px-1.5 text-[11px]' : 'h-6 px-2 text-xs',
        muted && 'opacity-50',
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${c} 32%, transparent)`,
        background: `color-mix(in srgb, ${c} 9%, var(--surface))`,
        color: `color-mix(in srgb, ${c} 72%, var(--ink))`,
      }}
    >
      {policy === 'REJECT' || policy === 'REJECT-DROP' ? (
        <Ban size={size === 'sm' ? 10 : 11} strokeWidth={2.25} />
      ) : (
        <LineDot color={c} size={size === 'sm' ? 6 : 7} hollow={builtin} />
      )}
      <span className="truncate">{policy}</span>
    </span>
  );
}

/* ─── group type metadata ────────────────────────────────────────────── */

export const GROUP_TYPES = {
  select: {
    label: '手动选择',
    short: '手选',
    description: '在客户端里手动切换使用哪一个成员',
    icon: CornerDownRight,
  },
  'url-test': {
    label: '自动测速',
    short: '测速',
    description: '定时测延迟，自动选用最快的成员',
    icon: Gauge,
  },
  fallback: {
    label: '故障转移',
    short: '容灾',
    description: '按顺序使用第一个可用的成员，挂了自动切下一个',
    icon: ShieldCheck,
  },
  'load-balance': {
    label: '负载均衡',
    short: '均衡',
    description: '把连接分散到多个成员上',
    icon: Shuffle,
  },
} as const;

export type GroupTypeKey = keyof typeof GROUP_TYPES;

export function groupTypeMeta(type: string) {
  return GROUP_TYPES[type as GroupTypeKey] ?? { label: type, short: type, description: '', icon: Layers };
}

export const RelayIcon = Equal;
