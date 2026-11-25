'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { ChevronsUpDown, CircleAlert, RefreshCw } from 'lucide-react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { errorMessage } from '@/ui/data/api';
import { useDevicePreview } from '@/ui/data/hooks';
import { cn } from '@/ui/lib/cn';
import { DataView } from '@/ui/agent';
import { Badge, Button, Card, CardHeader, SegmentedControl, Skeleton } from '@/ui/primitives';
import { draftDeviceYaml, parseShared, type Patch } from './model';

interface Line {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  no: number;
}

type Row = { type: 'line'; line: Line } | { type: 'gap'; from: number; count: number };

function toLines(shared: string, device: string): Line[] {
  const out: Line[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const change of diffLines(shared, device)) {
    const parts = change.value.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    for (const text of parts) {
      if (change.added) out.push({ kind: 'add', text, no: ++newNo });
      else if (change.removed) out.push({ kind: 'del', text, no: ++oldNo });
      else {
        oldNo++;
        out.push({ kind: 'ctx', text, no: ++newNo });
      }
    }
  }
  return out;
}

function collapse(lines: Line[], context: number, expanded: Set<number>): Row[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.kind === 'ctx') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      rows.push({ type: 'line', line: lines[i] });
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    const count = j - i;
    if (count <= 2 || expanded.has(i)) for (let k = i; k < j; k++) rows.push({ type: 'line', line: lines[k] });
    else rows.push({ type: 'gap', from: i, count });
    i = j;
  }
  return rows;
}

export function PreviewPanel({
  profileId,
  deviceId,
  draft,
  dirty,
  hasTailscale,
}: {
  profileId: string;
  deviceId: string;
  /** The current, statically valid draft patch — or null when it can't be previewed. */
  draft: Patch | null;
  dirty: boolean;
  hasTailscale: boolean;
}) {
  const preview = useDevicePreview(profileId, deviceId);
  const [view, setView] = useState<'diff' | 'full'>('diff');
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const deferredDraft = useDeferredValue(draft);
  const sharedRoot = useMemo(() => parseShared(preview.data?.shared), [preview.data?.shared]);

  const isDraft = dirty && !!deferredDraft && !!sharedRoot;
  const shared = preview.data?.shared ?? '';
  const device = useMemo(() => {
    if (isDraft && sharedRoot && deferredDraft) return draftDeviceYaml(sharedRoot, deferredDraft);
    return preview.data?.device ?? null;
  }, [isDraft, sharedRoot, deferredDraft, preview.data?.device]);

  const lines = useMemo(() => (device === null ? [] : toLines(shared, device)), [shared, device]);
  const stats = useMemo(
    () => ({
      add: lines.filter((l) => l.kind === 'add').length,
      del: lines.filter((l) => l.kind === 'del').length,
    }),
    [lines],
  );
  const rows = useMemo<Row[]>(
    () => (view === 'full' ? lines.map((line) => ({ type: 'line' as const, line })) : collapse(lines, 3, expanded)),
    [lines, view, expanded],
  );
  const issues = !isDraft ? (preview.data?.issues ?? []) : [];

  return (
    <Card className="min-w-0 animate-rise overflow-hidden [animation-delay:60ms]">
      <CardHeader
        title="生效预览"
        description="这台设备最终拿到的配置，与共享配置相比改了哪些行"
        actions={
          <>
            <SegmentedControl
              size="sm"
              label="预览视图"
              value={view}
              onChange={setView}
              options={[
                { value: 'diff', label: '只看差异' },
                { value: 'full', label: '完整配置' },
              ]}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={RefreshCw}
              aria-label="重新渲染预览"
              loading={preview.isValidating}
              onClick={() => void preview.refetch()}
            />
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-xs text-ink-3">
        {isDraft ? (
          <Badge tone="warn">草稿 · 未保存</Badge>
        ) : (
          <Badge tone="neutral">已保存的版本</Badge>
        )}
        {device !== null && preview.data && (
          <span className="tnum">
            <span className="text-ok">+{stats.add}</span> <span className="text-bad">−{stats.del}</span> 行
          </span>
        )}
        {isDraft && hasTailscale && <span>Tailscale 注入的部分保存后才会出现在预览里</span>}
      </div>

      {preview.error && !preview.data ? (
        <div className="flex items-start gap-2.5 border-t border-line px-4 py-4">
          <CircleAlert size={15} className="mt-0.5 shrink-0 text-bad" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium text-ink">共享配置渲染失败，暂时无法预览</div>
            <p className="mt-0.5 break-words text-xs text-ink-3">{errorMessage(preview.error)}</p>
            <Button className="mt-2" size="sm" icon={RefreshCw} onClick={() => void preview.refetch()}>
              重试
            </Button>
          </div>
        </div>
      ) : !preview.data ? (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-4">
          {[72, 58, 84, 40, 66, 52].map((w, i) => (
            <Skeleton key={i} className="h-3.5" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <DataView
          label="设备生效预览"
          summary={
            device === null
              ? '差异无效'
              : stats.add + stats.del === 0
                ? '与共享配置一致'
                : `${isDraft ? '草稿' : '已保存'} · +${stats.add} −${stats.del} 行`
          }
          items={[
            ...issues.map((issue, i) => ({
              value: `issue:${i}`,
              label: `错误${issue.path ? ` (${issue.path})` : ''}：${issue.message}`,
            })),
            ...lines
              .filter((l) => l.kind !== 'ctx')
              .slice(0, 120)
              .map((l, i) => ({
                value: `diff:${i}`,
                label: `${l.kind === 'add' ? '+' : '-'}${l.text}`,
              })),
          ]}
        >
          {issues.length > 0 && (
            <ul className="flex flex-col gap-2 border-t border-line px-4 py-3">
              {issues.map((issue, i) => (
                <li key={i} className="flex gap-2.5 rounded-lg border border-bad/20 bg-bad-soft px-3 py-2.5 text-sm">
                  <CircleAlert size={15} className="mt-0.5 shrink-0 text-bad" />
                  <div className="min-w-0">
                    <div className="text-ink">{issue.message}</div>
                    {issue.path && <div className="mt-0.5 font-mono text-[11px] text-ink-3">{issue.path}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {device === null ? (
            <p className="border-t border-line px-4 py-6 text-center text-xs text-ink-3">差异无效，修正后才能生成这台设备的配置。</p>
          ) : stats.add + stats.del === 0 ? (
            <p className="border-t border-line px-4 py-8 text-center text-xs text-ink-3">
              与共享配置完全一致 —— 添加差异后，这里会显示具体改了哪些行。
            </p>
          ) : (
            <div className={cn('overflow-auto border-t border-line', view === 'full' && 'max-h-[70vh]')}>
              <div className="w-max min-w-full py-1.5 font-mono text-[11.5px] leading-[1.65]">
                {rows.map((row, i) =>
                  row.type === 'gap' ? (
                    <UiButton
                      key={`gap-${row.from}`}
                      onClick={() => setExpanded((prev) => new Set(prev).add(row.from))}
                      className="my-0.5 flex w-full items-center gap-2 bg-surface-2/70 px-3 py-0.5 font-sans text-[11px] text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                    >
                      <ChevronsUpDown size={12} />
                      展开 {row.count} 行相同内容
                    </UiButton>
                  ) : (
                    <div
                      key={i}
                      className={cn(
                        'flex',
                        row.line.kind === 'add' && 'bg-ok-soft',
                        row.line.kind === 'del' && 'bg-bad-soft',
                      )}
                    >
                      <span className="w-11 shrink-0 select-none pr-2 text-right text-ink-4">{row.line.no}</span>
                      <span
                        className={cn(
                          'w-4 shrink-0 select-none text-center',
                          row.line.kind === 'add' ? 'text-ok' : row.line.kind === 'del' ? 'text-bad' : 'text-ink-4',
                        )}
                      >
                        {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ''}
                      </span>
                      <span
                        className={cn(
                          'whitespace-pre pr-4',
                          row.line.kind === 'ctx' ? 'text-ink-2' : 'text-ink',
                        )}
                      >
                        {row.line.text || ' '}
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </DataView>
      )}
    </Card>
  );
}
