'use client';

import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { ProxyGroup } from '@/schemas';
import { KIND_LABELS, TYPE_GLYPH } from '../_lib/model';
import type { MemberStat } from '../_lib/useAvailableMembers';

/**
 * Structured group list: grouped by `section` (sorted by the lowest rank in
 * each section so order tracks the rendered config), with a type glyph, the
 * effective member count, and a `← N` reverse-reference badge per row.
 */
export function LeftRail({
  groups,
  selectedId,
  query,
  onQuery,
  onSelect,
  onCreate,
  stat,
  refCount,
  creating,
}: {
  groups: ProxyGroup[];
  selectedId: string | null;
  query: string;
  onQuery: (v: string) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  stat: (g: ProxyGroup) => MemberStat;
  refCount: (name: string) => number;
  creating: boolean;
}) {
  const q = query.trim().toLowerCase();
  const sections = useMemo(() => {
    const map = new Map<string, ProxyGroup[]>();
    for (const g of groups) {
      if (q && !g.name.toLowerCase().includes(q)) continue;
      // No section captured at migration → segment by the group's kind so the
      // rail is still structured (系统组 / 地区组 / 服务组 …) instead of one bucket.
      const key = g.section?.trim() || KIND_LABELS[g.kind];
      const list = map.get(key) ?? [];
      list.push(g);
      map.set(key, list);
    }
    return Array.from(map.entries())
      .map(([section, items]) => ({
        section,
        items: items.slice().sort((a, b) => a.rank - b.rank),
        minRank: Math.min(...items.map((g) => g.rank)),
      }))
      .sort((a, b) => a.minRank - b.minRank);
  }, [groups, q]);

  return (
    <aside className="border-r border-[var(--color-border)] flex flex-col overflow-hidden">
      <div className="p-3 space-y-2 border-b border-[var(--color-border)]">
        <Button onClick={onCreate} disabled={creating} className="w-full">
          + 新建策略组
        </Button>
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="🔍 搜索策略组"
        />
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {sections.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-[var(--color-muted)]">
            {groups.length === 0 ? '还没有策略组,点上面新建。' : '无匹配。'}
          </p>
        ) : (
          sections.map(({ section, items }) => (
            <div key={section} className="mb-3">
              <div className="px-4 pb-1 flex items-baseline gap-2">
                <span className="text-[10px] tracking-[0.08em] uppercase text-[var(--color-muted)] font-semibold">
                  {section}
                </span>
                <span className="text-[10px] text-[var(--color-muted)]">{items.length}</span>
              </div>
              {items.map((g) => {
                const s = stat(g);
                const refs = refCount(g.name);
                const active = selectedId === g.id;
                return (
                  <button
                    key={g.id}
                    onClick={() => onSelect(g.id)}
                    className={`w-full text-left px-4 py-2 flex items-center gap-2 text-[13px] border-l-2 ${
                      active
                        ? 'bg-[var(--color-surface)] border-[var(--color-primary)] text-[var(--color-fg)]'
                        : 'border-transparent text-[var(--color-fg-soft)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <span
                      className="text-[13px] text-[var(--color-muted)] w-4 text-center shrink-0"
                      title={g.type}
                      aria-hidden
                    >
                      {TYPE_GLYPH[g.type]}
                    </span>
                    <span className="flex-1 truncate">{g.name}</span>
                    <span className="text-[11px] text-[var(--color-muted)] tabular-nums shrink-0">
                      {s.count} {s.unit}
                    </span>
                    {refs > 0 && (
                      <span
                        className="text-[10px] text-[var(--color-muted)] shrink-0"
                        title={`${refs} 条规则指向本组`}
                      >
                        ←{refs}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
