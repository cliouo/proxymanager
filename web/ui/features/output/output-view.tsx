'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  Download,
  FileCode2,
  Layers,
  LayoutTemplate,
  ListTree,
  QrCode,
  RefreshCw,
  Search,
  WrapText,
} from 'lucide-react';
import { ApiError, errorMessage } from '@/ui/data/api';
import { usePreview, useSources } from '@/ui/data/hooks';
import type { Collision, PreviewData, SnapshotSubStatus } from '@/ui/data/types';
import { CodeEditor, revealLine } from '@/ui/editor/code-editor';
import { cn } from '@/ui/lib/cn';
import { formatBytes, formatCount, formatDate, relativeTime } from '@/ui/lib/format';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CopyIcon,
  EmptyState,
  Monogram,
  notify,
  Numeral,
  Skeleton,
  Tooltip,
  useCopy,
} from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { profileTitle } from '@/ui/shell/profile-switcher';
import { useScope } from '@/ui/shell/scope';
import { openShare } from '@/ui/shell/state';
import { NodeName, RegionStrip } from '@/ui/viz/nodes';
import { attachExtensions } from '@/ui/features/base/editor-ext';
import { SECTION_LABEL, topLevelSections } from '@/ui/features/base/yaml-tools';

const COUNTED = new Set(['proxies', 'proxy-groups', 'rules', 'rule-providers', 'proxy-providers']);

export function OutputView() {
  const { profile, path } = useScope();
  const preview = usePreview(profile);
  const sources = useSources();
  const { copied, copy } = useCopy();
  const [view, setView] = useState<EditorView | null>(null);
  const [wrap, setWrap] = useState(false);
  const data = preview.data;
  const isTemplate = profile.kind === 'template';
  const title = profileTitle(profile);

  const sections = useMemo(() => (data ? topLevelSections(data.content) : []), [data]);
  const stats = useMemo(() => {
    if (!data) return null;
    const rules = data.anchors_applied.reduce((sum, a) => sum + a.ruleCount, 0);
    const providers = sections.find((s) => s.key === 'rule-providers')?.count ?? 0;
    const bytes = new Blob([data.content]).size;
    return { rules, providers, bytes, lines: data.content.split('\n').length };
  }, [data, sections]);
  const sourceName = useMemo(() => {
    const map = new Map((sources.data ?? []).map((s) => [s.name, s.display_name || s.name]));
    return (name: string) => map.get(name) ?? name;
  }, [sources.data]);

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.content], { type: 'text/yaml;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${profile.name}.yaml`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const rerender = async () => {
    const before = data?.build_id;
    const next = await preview.refetch();
    if (!next) {
      notify.error(preview.error ?? new Error('渲染失败'), '重新渲染失败');
      return;
    }
    if (next.build_id === before) notify.info('最终配置没有变化', `构建号仍是 ${next.build_id}`);
    else notify.success('已重新渲染', `新的构建号 ${next.build_id}`);
  };

  const scalarSection = sections.find((s) => !s.block);
  const blocks = sections.filter((s) => s.block);

  return (
    <Page width="wide">
      <PageHeader
        documentTitle={`最终配置 · ${title}`}
        eyebrow={
          <>
            <span>配置文件</span>
            <span className="font-mono text-[11px] text-ink-2">{profile.name}</span>
            {isTemplate && <Badge>模版</Badge>}
          </>
        }
        title="最终配置"
        description="客户端通过订阅链接拿到的就是这份配置。它在每次请求时按当前的节点、策略组和规则实时生成。"
        actions={
          <>
            <Button
              icon={<CopyIcon copied={copied} size={15} />}
              disabled={!data}
              onClick={() => data && void copy(data.content, '已复制最终配置')}
            >
              复制
            </Button>
            <Button icon={Download} disabled={!data} onClick={download}>
              下载
            </Button>
            <Tooltip content="按当前数据重新生成">
              <Button
                variant="ghost"
                iconOnly
                icon={<RefreshCw size={15} strokeWidth={1.75} className={cn(preview.isValidating && 'animate-spin-slow')} />}
                aria-label="重新渲染"
                disabled={preview.isValidating}
                onClick={() => void rerender()}
              />
            </Tooltip>
            {!isTemplate && (
              <Button variant="primary" icon={QrCode} onClick={openShare}>
                订阅链接
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {isTemplate && (
          <div className="flex animate-rise items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 p-4 text-sm text-ink-2">
            <LayoutTemplate size={18} className="mt-0.5 shrink-0 text-ink-3" />
            <div>
              <div className="font-medium text-ink">模版不对外分发</div>
              <p className="mt-1 text-xs leading-relaxed">
                客户端无法订阅模版，但这里的预览和真实渲染一致，可以用来检查从它派生的配置会长什么样。
              </p>
            </div>
          </div>
        )}

        {preview.isLoading ? (
          <OutputSkeleton />
        ) : !data ? (
          <RenderError error={preview.error} retry={() => void preview.refetch()} basePath={path('base')} />
        ) : (
          <>
            <Receipt data={data} stats={stats!} />
            <div className="grid gap-6 @4xl/main:grid-cols-[minmax(0,1fr)_340px]">
              <Card className="flex min-w-0 animate-rise flex-col overflow-hidden [animation-delay:60ms]">
                <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
                  <nav aria-label="跳到段落" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
                    {scalarSection && (
                      <JumpChip label="常规" onClick={() => view && revealLine(view, scalarSection.line)} />
                    )}
                    {blocks.map((section) => (
                      <JumpChip
                        key={`${section.key}-${section.line}`}
                        label={SECTION_LABEL[section.key] ?? section.key}
                        code={SECTION_LABEL[section.key] ? section.key : undefined}
                        count={COUNTED.has(section.key) ? section.count : null}
                        onClick={() => view && revealLine(view, section.line)}
                      />
                    ))}
                  </nav>
                  <Tooltip content="查找" shortcut="⌘F">
                    <Button size="sm" variant="ghost" iconOnly icon={Search} aria-label="查找" onClick={() => view && openSearchPanel(view)} />
                  </Tooltip>
                  <Tooltip content={wrap ? '不自动换行' : '自动换行'}>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={WrapText}
                      aria-label="自动换行"
                      aria-pressed={wrap}
                      className={cn(wrap && 'bg-surface-2 text-ink')}
                      onClick={() => setWrap((v) => !v)}
                    />
                  </Tooltip>
                </div>
                <div className="h-[min(72dvh,820px)] min-h-[420px]">
                  <CodeEditor
                    value={data.content}
                    readOnly
                    wrap={wrap}
                    onReady={(next) => {
                      attachExtensions(next);
                      setView(next);
                    }}
                  />
                </div>
              </Card>
              <div className="flex min-w-0 animate-rise flex-col gap-4 [animation-delay:120ms]">
                <Diagnostics data={data} basePath={path('base')} sourceName={sourceName} />
                <SourcesPanel data={data} sourceName={sourceName} />
                <AnchorsPanel
                  data={data}
                  onReveal={(anchor) => {
                    if (!view) return;
                    const index = data.content.split('\n').findIndex((l) => new RegExp(`ANCHOR:\\s*${anchor}\\s*===`).test(l));
                    if (index !== -1) revealLine(view, index + 1);
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}

/* ─── receipt strip ──────────────────────────────────────────────────── */

function Receipt({
  data,
  stats,
}: {
  data: PreviewData;
  stats: { rules: number; providers: number; bytes: number; lines: number };
}) {
  const cells: Array<{ label: string; value: ReactNode; sub: ReactNode }> = [
    {
      label: '节点',
      value: formatCount(data.inlined_proxy_count),
      sub: data.subscriptions?.length ? `来自 ${data.subscriptions.length} 个订阅源` : '没有注入订阅节点',
    },
    { label: '策略组', value: formatCount(data.proxy_group_count), sub: '由策略组页生成' },
    {
      label: '规则',
      value: formatCount(stats.rules),
      sub: `分布在 ${data.anchors_applied.length} 个锚点`,
    },
    {
      label: '规则集',
      value: formatCount(stats.providers),
      sub: stats.providers ? '被引用的才会写入' : '没有被引用的规则集',
    },
  ];
  return (
    <Card className="grid animate-rise grid-cols-2 gap-px overflow-hidden bg-line @3xl/main:grid-cols-[1.3fr_repeat(4,1fr)]">
      <div className="col-span-2 flex flex-col justify-between gap-3 bg-surface px-5 py-4 @3xl/main:col-span-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
          <FileCode2 size={13} strokeWidth={1.9} />
          构建号
        </div>
        <div className="font-mono text-[22px] font-medium leading-none tracking-tight text-ink">{data.build_id}</div>
        <div className="tnum text-xs text-ink-3">
          <Tooltip content={formatDate(data.rendered_at, true)}>
            <span>{relativeTime(data.rendered_at)}生成</span>
          </Tooltip>
          <span className="mx-1.5 text-ink-4">·</span>
          {formatBytes(stats.bytes)} · {formatCount(stats.lines)} 行
        </div>
      </div>
      {cells.map((cell) => (
        <div key={cell.label} className="flex flex-col gap-3 bg-surface px-5 py-4">
          <div className="text-xs font-medium text-ink-3">{cell.label}</div>
          <Numeral value={cell.value} className="text-[34px]" />
          <div className="truncate text-xs text-ink-3">{cell.sub}</div>
        </div>
      ))}
    </Card>
  );
}

function JumpChip({ label, code, count, onClick }: { label: string; code?: string; count?: number | null; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={code}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {label}
      {count !== null && count !== undefined && <span className="tnum text-2xs font-normal text-ink-4">{count}</span>}
    </button>
  );
}

/* ─── side panels ────────────────────────────────────────────────────── */

function Diagnostics({
  data,
  basePath,
  sourceName,
}: {
  data: PreviewData;
  basePath: string;
  sourceName: (name: string) => string;
}) {
  const warnings = data.warnings ?? [];
  const collisions = data.collisions ?? [];
  const unmatched = data.unmatched_anchors ?? [];
  if (!warnings.length && !collisions.length && !unmatched.length) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-ok/20 bg-ok-soft/60 px-4 py-3">
        <ListTree size={15} className="mt-0.5 shrink-0 text-ok" />
        <div>
          <div className="text-[13px] font-medium text-ink">没有需要留意的地方</div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-2">所有规则都找到了锚点，节点没有重名，渲染没有提示。</p>
        </div>
      </div>
    );
  }
  return (
    <Card>
      <CardHeader title="需要留意" icon={AlertTriangle} description="这些情况不会阻止下发，但可能和你预想的不一样。" />
      <ul className="flex flex-col divide-y divide-line border-t border-line">
        {unmatched.length > 0 && (
          <li className="px-4 py-3">
            <div className="text-[13px] font-medium text-ink">有规则找不到插入位置</div>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
              基础配置里缺少锚点 {unmatched.map((a) => `「${a}」`).join('')}，指向它们的规则没有进入这份配置。
            </p>
            <Button asChild size="xs" variant="secondary" trailingIcon={ArrowUpRight} className="mt-2">
              <Link href={basePath}>打开基础配置</Link>
            </Button>
          </li>
        )}
        {collisions.map((collision) => (
          <CollisionRow key={collision.name} collision={collision} sourceName={sourceName} />
        ))}
        {warnings.map((warning) => (
          <li key={warning} className="flex gap-2 px-4 py-3 text-xs leading-relaxed text-ink-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
            {warning}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CollisionRow({ collision, sourceName }: { collision: Collision; sourceName: (name: string) => string }) {
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Layers size={13} className="shrink-0 text-warn" />
        <NodeName name={collision.name} className="text-[13px] font-medium text-ink" />
      </div>
      <p className="pl-[21px] text-xs leading-relaxed text-ink-2">
        多个来源都有这个名字，只保留了
        {collision.keptFrom ? `「${sourceName(collision.keptFrom)}」` : '第一个'}的那个，丢弃了
        {collision.droppedFrom.map((d) => `「${sourceName(d)}」`).join('')}的同名节点
        {collision.resolvedTo ? `（已改名为「${collision.resolvedTo}」）` : ''}。
      </p>
    </li>
  );
}

function SourcesPanel({ data, sourceName }: { data: PreviewData; sourceName: (name: string) => string }) {
  const bySub = data.nodes_by_sub ?? {};
  const statuses = new Map((data.subscriptions ?? []).map((s) => [s.name, s]));
  const names = [...new Set([...Object.keys(bySub), ...statuses.keys()])];
  return (
    <Card>
      <CardHeader
        title="节点来源"
        description={names.length ? `${formatCount(data.inlined_proxy_count)} 个节点来自 ${names.length} 个订阅源` : undefined}
      />
      <div className="border-t border-line">
        {names.length === 0 ? (
          <p className="px-4 py-4 text-xs leading-relaxed text-ink-3">这份配置没有注入订阅节点。绑定订阅源或聚合订阅后，节点会出现在这里。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {names.map((name) => (
              <SourceRow key={name} name={name} label={sourceName(name)} nodes={bySub[name] ?? []} status={statuses.get(name)} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function SourceRow({
  name,
  label,
  nodes,
  status,
}: {
  name: string;
  label: string;
  nodes: string[];
  status?: SnapshotSubStatus;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface-2/50"
      >
        <Monogram name={label} colorKey={name} size={24} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{label}</span>
          <span className="tnum block text-2xs text-ink-3">
            {nodes.length} 个节点
            {status?.stale && <span className="text-warn"> · 用的是缓存</span>}
            {status?.error && <span className="text-bad"> · 拉取失败</span>}
          </span>
        </span>
        <ChevronRight size={14} className={cn('shrink-0 text-ink-4 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="flex animate-rise flex-col gap-2 px-4 pb-3">
          {(status?.staleReason || status?.error) && (
            <p className="text-2xs leading-relaxed text-ink-3">{status.error ?? status.staleReason}</p>
          )}
          <RegionStrip names={nodes} max={8} />
          <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-surface-2/50 p-2">
            {nodes.map((node) => (
              <li key={node} className="min-w-0 text-xs text-ink-2">
                <NodeName name={node} />
              </li>
            ))}
            {nodes.length === 0 && <li className="text-xs text-ink-3">没有节点进入最终配置</li>}
          </ul>
        </div>
      )}
    </li>
  );
}

function AnchorsPanel({ data, onReveal }: { data: PreviewData; onReveal: (anchor: string) => void }) {
  if (!data.anchors_applied.length) return null;
  const max = Math.max(1, ...data.anchors_applied.map((a) => a.ruleCount));
  return (
    <Card>
      <CardHeader title="规则锚点" description="规则按锚点顺序写入，点击跳到对应位置。" />
      <ul className="flex flex-col gap-1 border-t border-line p-2">
        {data.anchors_applied.map((anchor) => (
          <li key={anchor.anchor}>
            <button
              type="button"
              onClick={() => onReveal(anchor.anchor)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
            >
              <span className="truncate font-mono text-[12.5px] text-ink">{anchor.anchor}</span>
              <span className="tnum text-2xs text-ink-3">{anchor.ruleCount} 条</span>
              <span className="col-span-2 h-1 overflow-hidden rounded-full bg-surface-3">
                <span className="block h-full rounded-full bg-accent/60" style={{ width: `${(anchor.ruleCount / max) * 100}%` }} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ─── states ─────────────────────────────────────────────────────────── */

function OutputSkeleton() {
  return (
    <>
      <Card className="grid grid-cols-2 gap-6 p-5 @3xl/main:grid-cols-5">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex flex-col gap-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </Card>
      <div className="grid gap-6 @4xl/main:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex flex-col gap-2.5 p-5">
          {[30, 24, 36, 0, 22, 48, 44, 40, 52, 38, 0, 18, 46].map((w, i) =>
            w ? <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} /> : <div key={i} className="h-3" />,
          )}
        </Card>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    </>
  );
}

function RenderError({ error, retry, basePath }: { error: unknown; retry: () => void; basePath: string }) {
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <Card>
      <EmptyState
        icon={AlertTriangle}
        title="最终配置生成失败"
        description={errorMessage(error) || '渲染时出错了。'}
        actions={
          <>
            <Button variant="secondary" icon={RefreshCw} onClick={retry}>
              重试
            </Button>
            <Button asChild variant="ghost" trailingIcon={ArrowUpRight}>
              <Link href={basePath}>检查基础配置</Link>
            </Button>
          </>
        }
      />
      {issues.length > 1 && (
        <ul className="mx-auto mb-8 flex max-w-xl flex-col gap-1.5 px-6">
          {issues.map((issue, index) => (
            <li key={index} className="rounded-lg border border-bad/20 bg-bad-soft/60 px-3 py-2 text-xs text-ink-2">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
