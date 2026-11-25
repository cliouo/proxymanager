'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  FileCode2,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Search,
  TriangleAlert,
  WrapText,
} from 'lucide-react';
import { ApiError, api, type ConfigIssue } from '@/ui/data/api';
import { keys, refreshProfile, useAllRules, useBase, useGroups, useRuleSummary } from '@/ui/data/hooks';
import { setQueryData } from '@/ui/data/query';
import type { BaseData } from '@/ui/data/types';
import { CodeEditor, revealLine } from '@/ui/editor/code-editor';
import { cn } from '@/ui/lib/cn';
import { formatDate, relativeTime } from '@/ui/lib/format';
import {
  Button,
  Card,
  confirmAction,
  CopyButton,
  EmptyState,
  Kbd,
  notify,
  Popover,
  Skeleton,
  Spinner,
  Tooltip,
  useCopy,
} from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { profileTitle } from '@/ui/shell/profile-switcher';
import { useScope } from '@/ui/shell/scope';
import { attachExtensions, applyEdit, showDiagnostics, type CursorInfo, type LineDiagnostic } from './editor-ext';
import { MarkersSection, PoliciesSection, SnippetsSection, ValidationSection } from './inspector';
import {
  affectedRuleCount,
  groupOrphans,
  orphansFromError,
  useBaseValidation,
  type Orphan,
  type ValidationStatus,
} from './use-validation';
import {
  injectionMarkerEdit,
  restoreAnchorEdit,
  scanMarkers,
  snippetEdit,
  STARTER_BASE,
  type Snippet,
} from './yaml-tools';

const INSPECTOR_KEY = 'pm.base.inspector';

interface SaveResult {
  etag: string;
  anchors: string[];
  policies: string[];
  updated_at: number;
}

export function BaseEditor() {
  const router = useRouter();
  const { profile, profileId, path } = useScope();
  const base = useBase(profileId);
  const groups = useGroups(profileId);
  const summary = useRuleSummary(profileId);
  const rules = useAllRules(profileId);

  const notFound = base.error instanceof ApiError && base.error.status === 404;
  const saved = base.data;
  const [draft, setDraft] = useState<string | null>(null);
  const [draftBase, setDraftBase] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveIssues, setSaveIssues] = useState<ConfigIssue[] | null>(null);
  const [saveOrphans, setSaveOrphans] = useState<{ content: string; orphans: Orphan[] } | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [wrap, setWrap] = useState(false);
  const [inspector, setInspector] = useState(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(INSPECTOR_KEY) === '0') setInspector(false);
    } catch {
      /* ignore */
    }
  }, []);
  const toggleInspector = (next = !inspector) => {
    setInspector(next);
    try {
      window.localStorage.setItem(INSPECTOR_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const savedContent = saved?.content ?? '';
  const content = draft ?? savedContent;
  const dirty = draft !== null && draft !== savedContent;
  const ready = !!saved || (notFound && draft !== null);
  const stale = dirty && !!saved && !!draftBase && saved.etag !== draftBase;

  const validation = useBaseValidation(profileId, content, ready);
  const markers = useMemo(() => scanMarkers(content), [content]);
  const rulesById = useMemo(() => new Map((rules.data ?? []).map((r) => [r.id, r])), [rules.data]);
  const managedGroups = useMemo(
    () => (groups.data ?? []).slice().sort((a, b) => a.rank - b.rank).map((g) => g.name),
    [groups.data],
  );

  // Orphans for the current text: live verdict, else the last 422 from saving this exact text.
  const verdict = validation.result ?? (validation.status === 'checking' ? validation.lastResult : undefined);
  const orphanGroups = useMemo(() => {
    const list =
      verdict && !verdict.valid
        ? verdict.orphans
        : saveOrphans && saveOrphans.content === content
          ? saveOrphans.orphans
          : [];
    return groupOrphans(list, rulesById);
  }, [verdict, saveOrphans, content, rulesById]);
  const missingGroupsMarker = markers.some((m) => m.kind === 'proxy-groups') ? 0 : managedGroups.length;
  const policies = verdict?.policies ?? saved?.policies ?? [];

  /* editor wiring */
  const onReady = useCallback((next: EditorView) => {
    attachExtensions(next, setCursor);
    setView(next);
  }, []);

  const onChange = (value: string) => {
    setSaveIssues(null);
    if (saved && value === saved.content) {
      setDraft(null);
      setDraftBase(null);
      return;
    }
    setDraft(value);
    setDraftBase((prev) => prev ?? saved?.etag ?? null);
  };

  const reveal = (line: number) => {
    if (view) revealLine(view, line);
  };

  const diagnostics = useMemo<LineDiagnostic[]>(() => {
    const items: LineDiagnostic[] = [];
    if (validation.status === 'syntax' && validation.syntax && validation.syntax.message !== '内容为空') {
      items.push({ line: validation.syntax.line, col: validation.syntax.col, message: validation.syntax.message, severity: 'error' });
    }
    for (const group of orphanGroups) {
      if (group.kind === 'literal-rule') {
        items.push({ line: group.line, message: '规则要在「规则」页管理，这里只放锚点标记', severity: 'error' });
      }
    }
    return items;
  }, [validation.status, validation.syntax, orphanGroups]);

  useEffect(() => {
    if (view) showDiagnostics(view, diagnostics);
  }, [view, diagnostics]);

  /* save / discard / reload */
  const save = async () => {
    if (!dirty || saving || draft === null) return;
    if (validation.status === 'syntax' && validation.syntax) {
      notify.warn('YAML 有语法错误', `第 ${validation.syntax.line} 行：${validation.syntax.message}`);
      reveal(validation.syntax.line);
      return;
    }
    const body = draft;
    const etag = draftBase ?? saved?.etag ?? null;
    setSaving(true);
    try {
      const result = await api.put<SaveResult>(
        '/base',
        { content: body },
        { profileId },
        etag ? { 'If-Match': `"${etag}"` } : undefined,
      );
      setQueryData<BaseData>(keys.scoped(profileId, 'base'), { content: body, ...result });
      setDraft(null);
      setDraftBase(null);
      setConflict(false);
      setSaveIssues(null);
      setSaveOrphans(null);
      refreshProfile(profileId);
      notify.success('基础配置已保存', '客户端下次更新订阅时会拿到新的最终配置。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        setConflict(true);
      } else if (error instanceof ApiError && error.status === 422) {
        const orphans = orphansFromError(error);
        if (orphans) setSaveOrphans({ content: body, orphans });
        else setSaveIssues(error.issues.length ? error.issues : [{ message: error.detail ?? error.title }]);
        toggleInspector(true);
      }
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(null);
    setDraftBase(null);
    setSaveIssues(null);
    setConflict(false);
  };

  const reloadLatest = async () => {
    if (dirty) {
      const ok = await confirmAction({
        title: '载入最新版本？',
        description: '你在这里的修改会被丢弃。需要的话，先用「复制我的版本」把它们存到剪贴板。',
        confirmText: '丢弃并载入',
        tone: 'danger',
      });
      if (!ok) return;
    }
    await base.refetch();
    discard();
  };

  useHotkey('mod+s', () => void save(), { enabled: ready });

  // Guard against losing edits: tab close / reload, and in-app link clicks.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.origin !== window.location.origin) return;
      if (anchor.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      const href = anchor.pathname + anchor.search + anchor.hash;
      void confirmAction({
        title: '离开前不保存修改？',
        description: '基础配置有未保存的修改，离开后会丢失。',
        confirmText: '放弃修改并离开',
        cancelText: '留下',
        tone: 'danger',
      }).then((ok) => {
        if (ok) router.push(href);
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, router]);

  /* quick fixes */
  const restoreAnchor = (name: string) => {
    if (view) applyEdit(view, restoreAnchorEdit(view.state.doc.toString(), savedContent, name));
  };
  const insertMarker = (kind: 'rule-providers' | 'proxy-groups') => {
    if (view) applyEdit(view, injectionMarkerEdit(view.state.doc.toString(), kind));
  };
  const insertSnippet = (snippet: Snippet) => {
    if (!view) return;
    applyEdit(view, snippetEdit(view.state.doc.toString(), cursor?.placed ? cursor.line : null, snippet.body));
  };
  const findProviderLine = (name: string) => {
    const lines = content.split('\n');
    const start = lines.findIndex((l) => /^rule-providers:\s*$/.test(l));
    if (start === -1) return null;
    const hit = lines.findIndex((l, i) => i > start && new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(l));
    return hit === -1 ? null : hit + 1;
  };

  const status: ValidationStatus = validation.status;
  const ruleTotal = summary.data?.total;
  const title = `基础配置 · ${profileTitle(profile)}`;

  /* states before the editor */
  if (base.isLoading) return <BaseSkeleton title={title} />;
  if (base.error && !notFound && !saved) {
    return (
      <Shell title={title}>
        <Card className="mt-6">
          <EmptyState
            icon={TriangleAlert}
            title="基础配置加载失败"
            description={base.error instanceof Error ? base.error.message : String(base.error)}
            actions={
              <Button variant="secondary" icon={RotateCcw} onClick={() => void base.refetch()}>
                重试
              </Button>
            }
          />
        </Card>
      </Shell>
    );
  }
  if (notFound && draft === null) {
    return (
      <Shell title={title}>
        <Card className="mt-6">
          <EmptyState
            icon={FileCode2}
            title="这份配置还没有基础配置"
            description="基础配置是最终配置的骨架：DNS、TUN、端口等顶层设置，加上策略组、规则和规则集的插入标记。先从最小骨架开始，再按需补充。"
            actions={
              <Button
                variant="primary"
                onClick={() => {
                  setDraft(STARTER_BASE);
                  setDraftBase(null);
                }}
              >
                从最小骨架开始
              </Button>
            }
          />
        </Card>
      </Shell>
    );
  }

  return (
    <Shell title={title} full>
      {/* toolbar */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[17px] font-semibold tracking-tight text-ink">基础配置</h1>
            {dirty && (
              <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-warn">
                <span className="size-1.5 rounded-full bg-warn" />
                未保存
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-3">
            DNS、TUN、端口等顶层设置；策略组、规则和规则集在渲染时插入到标记处
            {saved && (
              <>
                <span className="mx-1.5 text-ink-4">·</span>
                <Tooltip content={`版本 ${saved.etag} · ${formatDate(saved.updated_at, true)}`}>
                  <span className="tnum">
                    <span className="font-mono text-[11px] text-ink-2">{saved.etag.slice(0, 8)}</span>
                    <span className="ml-1.5">{relativeTime(saved.updated_at)}保存</span>
                  </span>
                </Tooltip>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill
            status={status}
            groups={orphanGroups.length + (missingGroupsMarker ? 1 : 0)}
            rules={affectedRuleCount(orphanGroups)}
            onClick={() => {
              toggleInspector(true);
              window.setTimeout(() => document.getElementById('base-validation')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
            }}
          />
          <MarkerSyntax />
          <Tooltip content={inspector ? '收起检查器' : '展开检查器'}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={inspector ? PanelRightClose : PanelRightOpen}
              aria-label={inspector ? '收起检查器' : '展开检查器'}
              onClick={() => toggleInspector()}
            />
          </Tooltip>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
              放弃
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            loading={saving}
            disabled={!dirty}
            data-agent-confirm="保存基础配置 YAML"
          >
            保存
            <Kbd className="ml-0.5 h-4 min-w-4 border-inverse-ink/20 bg-transparent text-[10px] text-inverse-ink/70 shadow-none">⌘S</Kbd>
          </Button>
        </div>
      </header>

      {(conflict || stale) && <ConflictBanner content={content} onReload={() => void reloadLatest()} saveFailed={conflict} />}

      {/* editor + inspector */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 @4xl:flex-row">
        <Card className="flex h-[64dvh] min-h-[360px] min-w-0 flex-col overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1 @4xl:h-auto @4xl:flex-1">
          <div className="min-h-0 flex-1">
            <CodeEditor label="基础配置 YAML" value={content} onChange={onChange} onReady={onReady} wrap={wrap} language="yaml" />
          </div>
          <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface-2/50 px-3 text-2xs text-ink-3">
            <span className="tnum">{cursor ? `第 ${cursor.line} 行，第 ${cursor.col} 列` : `共 ${content.split('\n').length} 行`}</span>
            {cursor && <span className="tnum text-ink-4">共 {cursor.lines} 行</span>}
            <span className="flex-1" />
            <Tooltip content="查找" shortcut="⌘F">
              <UiButton
                type="button"
                aria-label="查找"
                onClick={() => view && openSearchPanel(view)}
                className="flex size-6 items-center justify-center rounded-md hover:bg-surface-3 hover:text-ink"
              >
                <Search size={13} />
              </UiButton>
            </Tooltip>
            <Tooltip content={wrap ? '不自动换行' : '自动换行'}>
              <UiButton
                type="button"
                aria-label="自动换行"
                aria-pressed={wrap}
                onClick={() => setWrap((v) => !v)}
                className={cn('flex size-6 items-center justify-center rounded-md hover:bg-surface-3 hover:text-ink', wrap && 'bg-surface-3 text-ink')}
              >
                <WrapText size={13} />
              </UiButton>
            </Tooltip>
            <span className="font-mono text-[10.5px] text-ink-4">YAML</span>
          </div>
        </Card>

        {inspector && (
          <aside
            aria-label="检查器"
            className="flex max-h-[42%] w-full shrink-0 animate-rise flex-col divide-y divide-line overflow-y-auto pr-1 @4xl:max-h-none @4xl:w-[300px]"
          >
            <ValidationSection
              validation={validation}
              groups={orphanGroups}
              stale={validation.status === 'checking'}
              totalRules={ruleTotal}
              missingGroupsMarker={missingGroupsMarker}
              saveIssues={saveIssues}
              groupsHref={path('groups')}
              onReveal={reveal}
              onRestoreAnchor={restoreAnchor}
              onInsertMarker={insertMarker}
              findProviderLine={findProviderLine}
            />
            <MarkersSection markers={markers} summary={summary.data} onReveal={reveal} onAddAnchor={restoreAnchor} />
            <PoliciesSection
              policies={policies}
              managed={managedGroups}
              usage={summary.data?.policies}
              loading={!saved && !verdict}
            />
            <SnippetsSection content={content} onInsert={insertSnippet} onReveal={reveal} />
          </aside>
        )}
      </div>
    </Shell>
  );
}

/* ─── pieces ─────────────────────────────────────────────────────────── */

function Shell({ title, full, children }: { title: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        '@container mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-5 pb-5 pt-5 sm:px-8',
        full && 'lg:h-full',
      )}
    >
      <title>{`${title} · ProxyManager`}</title>
      {children}
    </div>
  );
}

function BaseSkeleton({ title }: { title: string }) {
  return (
    <Shell title={title} full>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-7 w-40" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 @4xl:flex-row">
        <Card className="flex h-[64dvh] flex-1 flex-col gap-2.5 p-5 lg:h-auto">
          {[38, 22, 30, 0, 44, 0, 18, 52, 46, 40].map((w, i) =>
            w ? <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} /> : <div key={i} className="h-3" />,
          )}
        </Card>
        <div className="flex w-full flex-col gap-3 @4xl:w-[300px]">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    </Shell>
  );
}

function StatusPill({
  status,
  groups,
  rules,
  onClick,
}: {
  status: ValidationStatus;
  groups: number;
  rules: number;
  onClick: () => void;
}) {
  const view =
    status === 'checking'
      ? { tone: 'border-line bg-surface-2 text-ink-2', icon: <Spinner size={12} />, label: '校验中' }
      : status === 'valid' && groups === 0
        ? { tone: 'border-ok/20 bg-ok-soft text-ok', icon: <CircleCheck size={13} />, label: '结构有效' }
        : status === 'valid' || status === 'orphans'
          ? {
              tone: 'border-bad/20 bg-bad-soft text-bad',
              icon: <CircleAlert size={13} />,
              label: rules > 0 ? `${rules} 条规则会失效` : `${groups} 个问题`,
            }
          : status === 'syntax' || status === 'invalid'
            ? { tone: 'border-bad/20 bg-bad-soft text-bad', icon: <CircleAlert size={13} />, label: 'YAML 有误' }
            : status === 'empty'
              ? { tone: 'border-warn/25 bg-warn-soft text-warn', icon: <TriangleAlert size={13} />, label: '内容为空' }
              : { tone: 'border-warn/25 bg-warn-soft text-warn', icon: <TriangleAlert size={13} />, label: '无法校验' };
  return (
    <UiButton
      type="button"
      onClick={onClick}
      aria-live="polite"
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors hover:brightness-[0.98]',
        view.tone,
      )}
    >
      {view.icon}
      {view.label}
    </UiButton>
  );
}

const MARKER_DOCS = [
  {
    title: '规则锚点',
    where: '写在 rules: 下面，缩进两格',
    example: '  # === ANCHOR: manual ===',
    body: '每条规则属于一个锚点，渲染时按顺序插到锚点这一行。可以有多个锚点，名称只用字母、数字、_ 和 -。',
  },
  {
    title: '策略组注入点',
    where: '顶格写一行',
    example: '# === PROXY-GROUPS ===',
    body: '「策略组」页管理的组在这里展开成 proxy-groups:。有策略组时必须保留。',
  },
  {
    title: '规则集注入点',
    where: '顶格写一行',
    example: '# === RULE-PROVIDERS ===',
    body: '被启用的规则（或 DNS 等设置）引用的规则集，在这里展开成 rule-providers:。',
  },
];

function MarkerSyntax() {
  return (
    <Popover
      align="end"
      className="w-[min(380px,calc(100vw-24px))] p-0"
      trigger={
        <Button variant="ghost" size="sm" icon={BookOpen}>
          标记语法
        </Button>
      }
    >
      <div className="border-b border-line px-4 py-3">
        <div className="text-sm font-semibold text-ink">标记语法</div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
          基础配置只写骨架。策略组、规则和规则集在各自页面管理，渲染时插入到这三种标记的位置。每个标记单独占一行。
        </p>
      </div>
      <ul className="divide-y divide-line">
        {MARKER_DOCS.map((doc) => (
          <li key={doc.title} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-medium text-ink">{doc.title}</span>
              <span className="text-2xs text-ink-3">{doc.where}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">{doc.body}</p>
            <div className="mt-2 flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2.5 pr-0.5">
              <code className="min-w-0 flex-1 truncate whitespace-pre font-mono text-[11.5px] text-accent">{doc.example}</code>
              <CopyButton text={doc.example.trim()} size="sm" label="复制标记" />
            </div>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

function ConflictBanner({ content, onReload, saveFailed }: { content: string; onReload: () => void; saveFailed: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex animate-rise flex-wrap items-center gap-3 rounded-xl border border-warn/25 bg-warn-soft/70 px-4 py-3">
      <TriangleAlert size={16} className="shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">
          {saveFailed ? '保存失败：基础配置已被其他人修改' : '服务器上的基础配置已经更新'}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
          可能来自另一个窗口或 AI 助手。你的修改基于旧版本，直接保存会冲突。
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => void copy(content, '已复制你的版本')}>
          {copied ? '已复制' : '复制我的版本'}
        </Button>
        <Button size="sm" variant="secondary" icon={RotateCcw} onClick={onReload}>
          重新载入最新版本
        </Button>
      </div>
    </div>
  );
}
