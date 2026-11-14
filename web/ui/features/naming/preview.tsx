'use client';

import { Fragment, useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, Link2Off } from 'lucide-react';
import { codeFromFlag, regionByCode } from '@/lib/proxies/regions';
import { errorMessage } from '@/ui/data/api';
import { cn } from '@/ui/lib/cn';
import { Badge, Card, CardHeader, SegmentedControl, Skeleton, Spinner, Tooltip } from '@/ui/primitives';
import { Flag } from '@/ui/viz/nodes';
import { REF_KIND, type IssueSummary, type OrphanIssue, type PreviewRow } from './model';

const FLAG_SPLIT = /([\u{1F1E6}-\u{1F1FF}]{2})/u;

/** The exact name, with flag emoji rendered through `Flag` in place (never moved or invented). */
export function LiteralName({ name, className }: { name: string; className?: string }) {
  const parts = name.split(FLAG_SPLIT);
  return (
    <span className={cn('inline-flex min-w-0 items-center', className)} title={name}>
      <span className="truncate">
        {parts.map((part, i) => {
          if (i % 2 === 1) {
            const code = codeFromFlag(part);
            return code && regionByCode(code) ? (
              <Flag key={i} region={code} size={14} className="mx-px align-[-2px]" />
            ) : (
              <Fragment key={i}>{part}</Fragment>
            );
          }
          return <Fragment key={i}>{part}</Fragment>;
        })}
      </span>
    </span>
  );
}

type Filter = 'all' | 'changed' | 'attention';

export function PreviewPanel({
  rows,
  paired,
  summary,
  total,
  truncated,
  loading,
  validating,
  stale,
  error,
  className,
}: {
  rows: PreviewRow[] | null;
  paired: boolean;
  summary: IssueSummary | null;
  total: number | null;
  truncated: boolean;
  loading: boolean;
  validating: boolean;
  /** The draft is invalid; the shown result is the last valid one. */
  stale: boolean;
  error: unknown;
  className?: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const orphansByNode = useMemo(() => {
    const map = new Map<string, OrphanIssue[]>();
    for (const o of summary?.orphans ?? []) map.set(o.node, [...(map.get(o.node) ?? []), o]);
    return map;
  }, [summary]);
  const attention = (r: PreviewRow) => r.collision || !!r.removedFor || (r.before !== null && orphansByNode.has(r.before));
  const changed = rows?.filter((r) => r.before !== r.after).length ?? 0;
  const flagged = rows?.filter(attention).length ?? 0;
  const shown = (rows ?? []).filter((r) => (filter === 'changed' ? r.before !== r.after : filter === 'attention' ? attention(r) : true));

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            改名预览
            {validating && <Spinner size={12} />}
          </span>
        }
        description={paired ? '左边是配置里现在的名字，右边是应用后的名字。' : '应用后的完整名单。'}
        actions={
          rows && paired ? (
            <SegmentedControl
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'changed', label: `有变化 ${changed}` },
                { value: 'attention', label: `需留意 ${flagged}`, disabled: flagged === 0 },
              ]}
            />
          ) : undefined
        }
      />
      {summary && total !== null && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          <Badge>{total} 个节点</Badge>
          {paired && <Badge tone={changed ? 'accent' : 'neutral'}>{changed} 个改名</Badge>}
          {summary.collisions.length > 0 && <Badge tone="warn">{summary.collisions.length} 处重名已自动区分</Badge>}
          {summary.dedup.length > 0 && <Badge>{summary.dedup.length} 个重复节点会移除</Badge>}
          {summary.orphans.length > 0 && <Badge tone="bad">{summary.orphans.length} 处引用会失效</Badge>}
          {summary.duplicates.length > 0 && <Badge tone="bad">{summary.duplicates.length} 个名字仍重复</Badge>}
        </div>
      )}
      {(stale || !!error) && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-warn/25 bg-warn-soft/70 px-3 py-2 text-xs text-ink-2">
          <CircleAlert size={13} className="mt-px shrink-0 text-warn" />
          {stale ? '模板还有错误，预览停在上一次有效的结果。' : `预览失败：${errorMessage(error)}`}
        </div>
      )}
      {summary && summary.orphans.length > 0 && (
        <div className="mx-4 mb-3 rounded-lg border border-bad/20 bg-bad-soft/60 px-3 py-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-ink">
            <Link2Off size={13} className="text-bad" />
            改名后，这些按旧名字引用节点的地方会失效
          </div>
          <ul className="mt-1.5 flex flex-col gap-1 text-ink-2">
            {summary.orphans.slice(0, 8).map((o, i) => (
              <li key={i} className="truncate">
                {REF_KIND[o.kind] ?? o.kind}「{o.via}」→ <span className="font-mono text-[11.5px]">{o.node}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
        {loading || !rows ? (
          <div className="flex flex-col gap-3 p-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="grid grid-cols-[1fr_16px_1fr] items-center gap-3">
                <Skeleton className="h-4" style={{ width: `${70 - (i % 3) * 12}%` }} />
                <span />
                <Skeleton className="h-4" style={{ width: `${62 - (i % 4) * 8}%` }} />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-ink-3">没有符合条件的节点。</p>
        ) : (
          <div className={cn('divide-y divide-line transition-opacity', (stale || validating) && 'opacity-60')}>
            {paired && (
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] gap-3 bg-surface px-4 py-2 text-2xs font-medium text-ink-3">
                <span>现在</span>
                <span />
                <span>应用后</span>
              </div>
            )}
            {shown.map((row) => (
              <Row key={row.key} row={row} paired={paired} refs={row.before ? orphansByNode.get(row.before) : undefined} />
            ))}
          </div>
        )}
        {truncated && rows && (
          <p className="border-t border-line px-4 py-2.5 text-center text-2xs text-ink-4">只显示前 {rows.length} 个节点</p>
        )}
      </div>
    </Card>
  );
}

function Row({ row, paired, refs }: { row: PreviewRow; paired: boolean; refs?: OrphanIssue[] }) {
  const same = row.before === row.after;
  const after = row.after ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <LiteralName name={row.after} className={cn('text-[13px]', same ? 'text-ink-3' : 'font-medium text-ink')} />
      {same && paired && <span className="shrink-0 text-2xs text-ink-4">不变</span>}
      {row.collision && (
        <Tooltip content="和另一个节点重名，已自动加上来源和编号区分">
          <span className="shrink-0">
            <Badge tone="warn">重名已区分</Badge>
          </span>
        </Tooltip>
      )}
    </span>
  ) : (
    <Tooltip content={`和「${row.removedFor}」地址端口相同，是同一个节点，只保留一个`}>
      <span className="text-xs text-ink-3">重复节点，会移除</span>
    </Tooltip>
  );
  if (!paired) return <div className="px-4 py-2">{after}</div>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] items-center gap-3 px-4 py-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <LiteralName name={row.before ?? ''} className={cn('text-[13px] text-ink-2', !row.after && 'line-through decoration-ink-4')} />
        {refs && (
          <Tooltip content={`被${refs.map((r) => `${REF_KIND[r.kind] ?? r.kind}「${r.via}」`).join('、')}按名字引用，改名后会失效`}>
            <Link2Off size={13} className="shrink-0 text-bad" aria-label="引用会失效" />
          </Tooltip>
        )}
      </span>
      <ArrowRight size={13} className={same ? 'text-ink-4/50' : 'text-ink-4'} />
      {after}
    </div>
  );
}
