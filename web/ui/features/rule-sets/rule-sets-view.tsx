'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  BookMarked,
  CloudDownload,
  Globe,
  HardDrive,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  SearchX,
  Trash2,
} from 'lucide-react';
import { DataView } from '@/ui/agent';
import { api, request } from '@/ui/data/api';
import { refreshShared, useAllRules, useMeta, usePolicies, useRuleSets } from '@/ui/data/hooks';
import type { RuleSetListItem } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { formatBytes } from '@/ui/lib/format';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  confirmAction,
  copyText,
  EmptyState,
  Menu,
  notify,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  StatusDot,
} from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { profileTitle } from '@/ui/shell/profile-switcher';
import { useActiveProfile } from '@/ui/shell/scope';
import {
  BEHAVIOR_META,
  formatInterval,
  hostOf,
  sourceOf,
  SOURCE_LABEL,
  usageMap,
  usageText,
  type Behavior,
  type Usage,
} from './model';
import { RuleSetSheet, type SheetTarget } from './rule-set-sheet';

type SourceFilter = 'all' | 'local' | 'remote';

const COLS = '@3xl/main:grid-cols-[minmax(0,1.5fr)_150px_130px_minmax(0,1.1fr)_84px_32px]';

export function RuleSetsView() {
  const router = useRouter();
  const params = useSearchParams();
  const profile = useActiveProfile();
  const pid = profile?.id ?? null;
  const list = useRuleSets(pid);
  const rules = useAllRules(pid);
  const meta = useMeta(pid);
  const policies = usePolicies(pid);

  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [behavior, setBehavior] = useState<'all' | Behavior>('all');
  const [unusedOnly, setUnusedOnly] = useState(false);

  const sets = useMemo(() => (list.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [list.data]);
  const usage = useMemo(() => usageMap(sets, rules.data), [sets, rules.data]);
  const injected = sets.filter((s) => usage.get(s.name)?.injected).length;

  const filtered = sets.filter((set) => {
    const q = query.trim().toLowerCase();
    if (q && ![set.name, set.note ?? '', set.url ?? ''].some((v) => v.toLowerCase().includes(q))) return false;
    if (source !== 'all' && sourceOf(set) !== source) return false;
    if (behavior !== 'all' && set.behavior !== behavior) return false;
    if (unusedOnly && usage.get(set.name)?.injected) return false;
    return true;
  });

  const openId = params.get('open');
  const target: SheetTarget | null = params.get('new') === '1' ? { kind: 'create' } : openId ? { kind: 'edit', id: openId } : null;
  const go = (next: SheetTarget | null) => {
    const qs = next ? (next.kind === 'create' ? '?new=1' : `?open=${encodeURIComponent(next.id)}`) : '';
    router.replace(`/rule-sets${qs}`, { scroll: false });
  };

  const hostedBase = meta.data?.ruleProvidersBase;
  const copyHosted = async (set: RuleSetListItem) => {
    if (!hostedBase) return;
    if (await copyText(`${hostedBase}/${set.name}`)) notify.success('已复制托管地址', '可以直接在其他客户端里当作 rule-provider 地址使用。');
  };

  const localize = async (set: RuleSetListItem): Promise<boolean> => {
    if (!pid) return false;
    try {
      const res = await request<{ meta?: { bytes?: number } }>(`/rule-sets/${set.id}/localize`, {
        method: 'POST',
        body: {},
        query: { profileId: pid },
      });
      notify.success(`「${set.name}」已转为本地托管`, res?.meta?.bytes ? `下载了 ${formatBytes(res.meta.bytes)}，以后由本服务提供。` : undefined);
      refreshShared();
      return true;
    } catch (error) {
      notify.error(error, '转换失败');
      return false;
    }
  };

  const remove = async (set: RuleSetListItem) => {
    if (!pid) return;
    const ok = await confirmAction({
      title: `删除规则集「${set.name}」？`,
      description: '删除后所有配置文件都不能再引用它。若其他配置文件仍在使用，服务器会拒绝删除。可以在操作历史里撤销。',
      confirmText: '确认删除',
      confirmHint: `删除规则集「${set.name}」`,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/rule-sets/${set.id}`, { profileId: pid });
      notify.success(`已删除「${set.name}」`);
      if (openId === set.id) go(null);
      refreshShared();
    } catch (error) {
      notify.error(error, '删除失败');
    }
  };

  const loading = list.isLoading || !profile;
  const name = profile ? profileTitle(profile) : '';

  return (
    <Page width="wide">
      <PageHeader
        title="规则集"
        eyebrow={
          <>
            <span>全局共享</span>
            {profile && (
              <>
                <span className="text-ink-4">·</span>
                <span>用量按「{name}」统计</span>
              </>
            )}
          </>
        }
        description="可被多条规则复用的域名或 IP 列表。只有被启用的规则（或基础配置，如 DNS 的 nameserver-policy）引用的规则集，才会写进这份配置的最终配置。"
        actions={
          <Button variant="primary" icon={Plus} onClick={() => go({ kind: 'create' })}>
            新建规则集
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            aria-label="搜索规则集"
            value={query}
            onChange={setQuery}
            placeholder="搜索名称、备注或地址"
            className="w-full sm:w-64"
          />
          <SegmentedControl<SourceFilter>
            label="规则集来源筛选"
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: '全部' },
              { value: 'local', label: '本地托管' },
              { value: 'remote', label: '远程' },
            ]}
          />
          <div className="w-[120px]">
            <Select<'all' | Behavior>
              label="规则集行为筛选"
              value={behavior}
              onValueChange={setBehavior}
              options={[
                { value: 'all', label: '全部行为' },
                ...(Object.keys(BEHAVIOR_META) as Behavior[]).map((b) => ({ value: b, label: BEHAVIOR_META[b].label })),
              ]}
            />
          </div>
          <Checkbox checked={unusedOnly} onCheckedChange={setUnusedOnly} label="仅未使用" className="ml-1" />
          {!loading && (
            <span className="ml-auto text-xs tnum text-ink-3">
              {sets.length} 个规则集{rules.data ? ` · ${injected} 个写入最终配置` : ''}
            </span>
          )}
        </div>

        <Card className="animate-rise overflow-hidden">
          <div
            className={cn(
              'hidden gap-4 border-b border-line bg-surface-2/50 px-4 py-2 text-2xs font-medium text-ink-3 @3xl/main:grid',
              COLS,
            )}
          >
            <span>名称</span>
            <span>来源</span>
            <span>格式 · 行为</span>
            <span>在「{name || '当前配置'}」中</span>
            <span>更新</span>
            <span />
          </div>
          {loading ? (
            <ul className="divide-y divide-line">
              {[...Array(5)].map((_, i) => (
                <li key={i} className={cn('grid gap-4 px-4 py-3.5 @3xl/main:grid', COLS)}>
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="hidden h-5 w-20 @3xl/main:block" />
                  <Skeleton className="hidden h-4 w-24 @3xl/main:block" />
                  <Skeleton className="hidden h-4 w-28 @3xl/main:block" />
                  <Skeleton className="hidden h-4 w-12 @3xl/main:block" />
                </li>
              ))}
            </ul>
          ) : list.error ? (
            <EmptyState
              compact
              icon={BookMarked}
              title="规则集加载失败"
              description={(list.error as Error).message}
              actions={
                <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => void list.refetch()}>
                  重试
                </Button>
              }
            />
          ) : sets.length === 0 ? (
            <EmptyState
              icon={BookMarked}
              title="还没有规则集"
              description="把一批域名或 IP 收进一个规则集，就能在多条规则里反复引用。可以托管在这里，也可以填远程地址。"
              actions={
                <Button variant="primary" icon={Plus} onClick={() => go({ kind: 'create' })}>
                  新建规则集
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              compact
              icon={SearchX}
              title="没有符合条件的规则集"
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setQuery('');
                    setSource('all');
                    setBehavior('all');
                    setUnusedOnly(false);
                  }}
                >
                  清除筛选
                </Button>
              }
            />
          ) : (
            <DataView
              label="规则集列表"
              summary={`显示 ${filtered.length} / ${sets.length} 个规则集${rules.data ? ` · ${injected} 个写入最终配置` : ''}`}
              items={filtered.map((set) => {
                const src = sourceOf(set);
                const u = usage.get(set.name);
                return {
                  value: set.id,
                  label: `${set.name} · ${SOURCE_LABEL[src]} · ${set.format}/${set.behavior ?? '未设置'} · ${usageText(u)}${set.note ? ` · ${set.note}` : ''}`,
                };
              })}
            >
              <ul className="divide-y divide-line">
                {filtered.map((set) => (
                  <RuleSetRow
                    key={set.id}
                    set={set}
                    usage={usage.get(set.name)}
                    usageLoading={!rules.data}
                    onOpen={() => go({ kind: 'edit', id: set.id })}
                    onCopyHosted={hostedBase ? () => void copyHosted(set) : undefined}
                    onLocalize={() => void localize(set)}
                    onDelete={() => void remove(set)}
                  />
                ))}
              </ul>
            </DataView>
          )}
        </Card>
      </div>

      <RuleSetSheet
        target={target}
        onClose={() => go(null)}
        profileId={profile?.id}
        profileName={name}
        sets={sets}
        usage={usage}
        policies={policies.data}
        hostedBase={hostedBase}
        onDelete={(set) => void remove(set)}
        onLocalize={localize}
      />
    </Page>
  );
}

function RuleSetRow({
  set,
  usage,
  usageLoading,
  onOpen,
  onCopyHosted,
  onLocalize,
  onDelete,
}: {
  set: RuleSetListItem;
  usage: Usage | undefined;
  usageLoading: boolean;
  onOpen: () => void;
  onCopyHosted?: () => void;
  onLocalize: () => void;
  onDelete: () => void;
}) {
  const src = sourceOf(set);
  const used = !!usage && (usage.active.length > 0 || usage.disabled.length > 0 || usage.inBase);
  const behavior = set.behavior ? BEHAVIOR_META[set.behavior as Behavior] : null;
  return (
    <li
      className={cn('group grid cursor-pointer grid-cols-[minmax(0,1fr)_32px] items-center gap-x-4 gap-y-1.5 px-4 py-3 transition-colors hover:bg-surface-2/50', COLS)}
      onClick={onOpen}
    >
      <div className="min-w-0">
        <UiButton
          type="button"
          aria-label={`编辑规则集「${set.name}」`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="block max-w-full truncate text-left font-mono text-[13px] font-medium text-ink outline-none focus-visible:underline"
        >
          {set.name}
        </UiButton>
        <div className="truncate text-xs text-ink-3">
          {set.note || (src === 'remote' ? <span className="font-mono text-[11px]">{hostOf(set.url)}</span> : '—')}
        </div>
        {/* compact meta for small screens */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 @3xl/main:hidden">
          <SourceBadge source={src} />
          <Badge mono>{set.format}</Badge>
          {behavior && <Badge>{behavior.label}</Badge>}
          <UsageLabel usage={usage} loading={usageLoading} />
        </div>
      </div>
      <div className="hidden min-w-0 flex-col items-start gap-1 @3xl/main:flex">
        <SourceBadge source={src} />
        {src === 'remote' && set.note && (
          <span className="max-w-full truncate font-mono text-[10.5px] text-ink-4" title={set.url}>
            {hostOf(set.url)}
          </span>
        )}
      </div>
      <div className="hidden text-xs text-ink-2 @3xl/main:block">
        <span className="font-mono text-[11.5px]">{set.format}</span>
        <span className="mx-1 text-ink-4">·</span>
        {behavior ? <span title={behavior.hint}>{behavior.label}</span> : <span className="text-warn">未设置</span>}
      </div>
      <div className="hidden @3xl/main:block">
        <UsageLabel usage={usage} loading={usageLoading} />
      </div>
      <div className="hidden text-xs tnum text-ink-3 @3xl/main:block">{formatInterval(set.interval)}</div>
      <div className="row-start-1 col-start-2 flex justify-end @3xl/main:col-start-auto @3xl/main:row-start-auto" onClick={(event) => event.stopPropagation()}>
        <Menu
          trigger={<Button size="sm" variant="ghost" iconOnly icon={MoreHorizontal} aria-label={`${set.name} 的操作`} />}
          items={[
            { label: '编辑', icon: Pencil, onSelect: onOpen },
            ...(src === 'local' && onCopyHosted ? [{ label: '复制托管地址', icon: Link2, onSelect: onCopyHosted }] : []),
            ...(src === 'remote' && set.format !== 'mrs'
              ? [
                  {
                    label: '转为本地托管',
                    icon: CloudDownload,
                    onSelect: onLocalize,
                    hint: '下载一次',
                    confirm: `将规则集「${set.name}」转为本地托管`,
                  },
                ]
              : []),
            'separator' as const,
            { label: '删除', icon: Trash2, tone: 'danger' as const, onSelect: onDelete, disabled: used, hint: used ? '使用中' : undefined },
          ]}
        />
      </div>
    </li>
  );
}

function SourceBadge({ source }: { source: 'local' | 'remote' }) {
  return (
    <Badge tone={source === 'local' ? 'accent' : 'outline'} icon={source === 'local' ? HardDrive : Globe}>
      {SOURCE_LABEL[source]}
    </Badge>
  );
}

function UsageLabel({ usage, loading }: { usage: Usage | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-3.5 w-24" />;
  const injected = !!usage?.injected;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', injected ? 'text-ink' : 'text-ink-4')}>
      <StatusDot tone={injected ? 'ok' : 'idle'} size={6} />
      <span className="truncate">{usageText(usage)}</span>
    </span>
  );
}
