'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { CircleAlert, Info, RotateCcw, TriangleAlert } from 'lucide-react';
import { errorMessage } from '@/ui/data/api';
import type { PipelinePreview, PreviewIssue } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Button, Card, SearchInput, SegmentedControl, Skeleton, Spinner } from '@/ui/primitives';
import { NodeName, RegionStrip } from '@/ui/viz/nodes';
import { REFERENCE_KIND_LABEL } from './model';

/* ─── issues ─────────────────────────────────────────────────────────── */

interface IssueView {
  tone: 'warn' | 'info';
  title: ReactNode;
  detail: string;
}

const q = (text: unknown) => <span className="font-medium text-ink">「{String(text)}」</span>;

export function describeIssue(issue: PreviewIssue): IssueView {
  const record = issue as Record<string, unknown>;
  switch (issue.code) {
    case 'duplicate-final-name':
      return {
        tone: 'warn',
        title: (
          <>
            {q(record.name)}重名了 {String(record.count)} 个
          </>
        ),
        detail: '同名节点在客户端里会互相覆盖，只剩一个能用。可以加一个「去重」步骤并选「改名区分」。',
      };
    case 'rename-collision-resolved':
      return {
        tone: 'info',
        title: <>{q(record.name)}撞名，已自动区分</>,
        detail: '智能命名后出现了相同的名字，已自动加上后缀区分，不影响使用。',
      };
    case 'true-dedup':
      return {
        tone: 'info',
        title: (
          <>
            {q(record.dropped)}和{q(record.kept)}是同一个节点
          </>
        ),
        detail: `两者的服务器配置完全相同，只保留了「${String(record.kept)}」。`,
      };
    case 'orphaned-reference': {
      const label = REFERENCE_KIND_LABEL[String(record.kind)] ?? '配置';
      return {
        tone: 'warn',
        title: (
          <>
            {label}
            {q(record.via)}会找不到{q(record.node)}
          </>
        ),
        detail: `这个节点会被改名或移除，而${label}是按名字引用它的。保存后请一并更新那里的引用。`,
      };
    }
    default:
      return { tone: 'info', title: <span className="font-mono text-xs">{issue.code}</span>, detail: '' };
  }
}

export function IssueList({ issues, limit = 4 }: { issues: PreviewIssue[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const views = useMemo(
    () => issues.map(describeIssue).sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'warn' ? -1 : 1)),
    [issues],
  );
  if (views.length === 0) return null;
  const shown = expanded ? views : views.slice(0, limit);
  return (
    <ul className="flex flex-col gap-1.5">
      {shown.map((view, index) => (
        <li
          key={index}
          className={cn(
            'flex gap-2 rounded-lg border px-2.5 py-2',
            view.tone === 'warn' ? 'border-warn/25 bg-warn-soft/60' : 'border-line bg-surface-2/60',
          )}
        >
          {view.tone === 'warn' ? (
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warn" />
          ) : (
            <Info size={13} className="mt-0.5 shrink-0 text-ink-3" />
          )}
          <div className="min-w-0 text-xs leading-relaxed">
            <div className="text-ink-2">{view.title}</div>
            {view.detail && <div className="mt-0.5 text-ink-3">{view.detail}</div>}
          </div>
        </li>
      ))}
      {views.length > limit && (
        <li>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-accent hover:underline underline-offset-4"
          >
            {expanded ? '收起' : `还有 ${views.length - limit} 条`}
          </button>
        </li>
      )}
    </ul>
  );
}

export function MemberErrors({ errors }: { errors?: Array<{ name: string; error: string }> }) {
  if (!errors?.length) return null;
  return (
    <div className="rounded-lg border border-bad/20 bg-bad-soft px-2.5 py-2 text-xs leading-relaxed">
      <div className="flex items-center gap-1.5 font-medium text-bad">
        <CircleAlert size={13} />
        {errors.length} 个成员拉取失败，这次没有提供节点
      </div>
      <ul className="mt-1 flex flex-col gap-0.5 text-ink-2">
        {errors.map((item, index) => (
          <li key={index} className="min-w-0 truncate" title={item.error}>
            <span className="font-medium text-ink">{item.name}</span>
            <span className="text-ink-3"> · {item.error}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─── node list ──────────────────────────────────────────────────────── */

export function NodeList({
  names,
  query,
  className,
  numbered = true,
}: {
  names: string[];
  query: string;
  className?: string;
  numbered?: boolean;
}) {
  const needle = query.trim().toLowerCase();
  const rows = useMemo(
    () => names.map((name, index) => ({ name, index })).filter((row) => !needle || row.name.toLowerCase().includes(needle)),
    [names, needle],
  );
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-ink-3">{needle ? '没有匹配的节点' : '没有节点'}</p>;
  }
  return (
    <ul className={cn('flex flex-col', className)}>
      {rows.map((row) => (
        <li key={`${row.index}:${row.name}`} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-2">
          {numbered && <span className="tnum w-6 shrink-0 text-right text-2xs text-ink-4">{row.index + 1}</span>}
          <NodeName name={row.name} className="min-w-0 text-ink" />
        </li>
      ))}
    </ul>
  );
}

/* ─── panel ──────────────────────────────────────────────────────────── */

export interface PreviewState {
  data: PipelinePreview | undefined;
  error: unknown;
  loading: boolean;
  stale: boolean;
  retry: () => void;
}

export function PreviewPanel({
  preview,
  paused,
  dirty,
  showMembers,
}: {
  preview: PreviewState;
  paused: boolean;
  dirty: boolean;
  showMembers?: boolean;
}) {
  const [side, setSide] = useState<'after' | 'before'>('after');
  const [query, setQuery] = useState('');
  const data = preview.data;
  const payload = data ? (side === 'after' ? data.after : data.before) : null;
  const delta = data ? data.after.count - data.before.count : 0;
  const status = paused
    ? '已暂停'
    : preview.loading
      ? '计算中…'
      : preview.error
        ? '预览失败'
        : dirty
          ? '按未保存的修改计算'
          : '与已保存的流程一致';

  return (
    <Card className="overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-ink">实时预览</h3>
          <p className="mt-0.5 text-xs text-ink-3">{status}</p>
        </div>
        {preview.loading && <Spinner size={14} />}
      </header>

      <div className="grid grid-cols-2 divide-x divide-line border-y border-line">
        <div className="px-4 py-3">
          <div className="text-2xs text-ink-3">处理前</div>
          <div className={cn('tnum mt-1 font-display text-[28px] leading-none text-ink', preview.stale && 'opacity-50')}>
            {data ? data.before.count : <Skeleton className="h-7 w-10" />}
          </div>
        </div>
        <div className="px-4 py-3">
          <div className="text-2xs text-ink-3">处理后</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={cn('tnum font-display text-[28px] leading-none text-ink', preview.stale && 'opacity-50')}>
              {data ? data.after.count : <Skeleton className="h-7 w-10" />}
            </span>
            {data && delta !== 0 && (
              <span className={cn('tnum text-xs font-medium', delta < 0 ? 'text-bad' : 'text-ok')}>
                {delta > 0 ? `+${delta}` : delta}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-3.5">
        {paused && (
          <p className="flex items-start gap-1.5 rounded-lg bg-surface-2 px-2.5 py-2 text-xs leading-relaxed text-ink-2">
            <Info size={13} className="mt-0.5 shrink-0 text-ink-3" />
            有步骤还没填写完整，补全后会自动重新预览。
          </p>
        )}
        {!!preview.error && !paused && (
          <div className="flex items-start gap-2 rounded-lg border border-bad/20 bg-bad-soft px-2.5 py-2 text-xs leading-relaxed">
            <CircleAlert size={13} className="mt-0.5 shrink-0 text-bad" />
            <span className="min-w-0 flex-1 text-ink-2">{errorMessage(preview.error)}</span>
            <Button size="xs" variant="ghost" icon={RotateCcw} onClick={preview.retry}>
              重试
            </Button>
          </div>
        )}
        {showMembers && <MemberErrors errors={data?.memberErrors} />}
        {data && data.issues.length > 0 && <IssueList issues={data.issues} />}
        {data && data.after.names.length > 0 && <RegionStrip names={data.after.names} max={8} />}

        <div className="flex items-center gap-2">
          <SegmentedControl
            size="sm"
            value={side}
            onChange={setSide}
            options={[
              { value: 'after', label: '处理后' },
              { value: 'before', label: '处理前' },
            ]}
          />
          <SearchInput value={query} onChange={setQuery} inputSize="sm" placeholder="搜索节点" className="min-w-0 flex-1" />
        </div>

        {!data ? (
          <div className="flex flex-col gap-2 py-1">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-5" style={{ width: `${60 + ((i * 17) % 35)}%` }} />
            ))}
          </div>
        ) : (
          <div className={cn('-mx-1.5 max-h-[420px] overflow-y-auto', preview.stale && 'opacity-60')}>
            <NodeList names={payload?.names ?? []} query={query} />
          </div>
        )}
        {payload?.truncated && (
          <p className="text-2xs text-ink-3">只列出前 {payload.names.length} 个，共 {payload.count} 个节点。</p>
        )}
      </div>
    </Card>
  );
}
