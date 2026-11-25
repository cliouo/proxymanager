'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import { Radio, RadioGroup, RadioIndicator } from '@ui-sdk/react/radio';
import { ArrowUpRight, Boxes, FileCode2, Layers, Plus, QrCode, RotateCcw, Trash2, X } from 'lucide-react';
import { DataView } from '@/ui/agent';
import { errorMessage } from '@/ui/data/api';
import { useMeta, useProfiles, useSourceUsage } from '@/ui/data/hooks';
import { useQuery } from '@/ui/data/query';
import type { StoredOperator } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Button, Card, EmptyState, Input, Monogram, SearchInput, SegmentedControl, Skeleton } from '@/ui/primitives';
import { useActiveProfile } from '@/ui/shell/scope';
import { LinkRow, QrImage } from '@/ui/shell/share-dialog';
import { countRegions, Flag, describeNode } from '@/ui/viz/nodes';
import { previewCandidate } from '@/ui/pipeline/model';
import { IssueList, MemberErrors, NodeList } from '@/ui/pipeline/preview-panel';
import { fetchPreview, type PipelineTarget } from '@/ui/pipeline/use-preview';
import { newId, POLICY_OPTIONS, withBase64, type FailurePolicy, type HeaderRow } from './model';

/* ─── tabs synced to ?tab= (visited panels stay mounted to keep drafts) ─ */

export function useTabParam<T extends string>(tabs: readonly T[], fallback: T) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get('tab') as T | null;
  const tab = raw && tabs.includes(raw) ? raw : fallback;
  const [visited, setVisited] = useState<Set<T>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  const setTab = (next: string) => {
    const query = new URLSearchParams(params.toString());
    if (next === fallback) query.delete('tab');
    else query.set('tab', next);
    const qs = query.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { tab, setTab, visited };
}

/** Tabs list scrolls sideways on narrow screens instead of overflowing. */
export const TAB_SCROLL =
  '[&_[role=tablist]]:overflow-x-auto [&_[role=tablist]]:overflow-y-hidden [&_[role=tablist]]:[scrollbar-width:none] [&_[role=tab]]:shrink-0 [&_[role=tab]]:whitespace-nowrap';

/* ─── nodes tab ──────────────────────────────────────────────────────── */

export function NodesPanel({
  target,
  operators,
  version,
  enabled,
}: {
  target: PipelineTarget;
  operators: StoredOperator[];
  version: number | undefined;
  enabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState<string | null | 'all'>('all');
  const prefix = target.kind === 'subscription' ? 'source' : 'pool';
  const result = useQuery(enabled ? `${prefix}:${target.id}:nodes:${version ?? 0}` : null, () =>
    fetchPreview(target, previewCandidate(operators)),
  );
  const names = useMemo(() => result.data?.after.names ?? [], [result.data]);
  const regions = useMemo(() => countRegions(names), [names]);
  const filtered = useMemo(
    () => (region === 'all' ? names : names.filter((name) => describeNode(name).region === region)),
    [names, region],
  );

  if (!enabled) {
    return <EmptyState icon={Layers} title="已停用" description="停用后不会拉取，也不提供节点。启用后这里会显示节点列表。" />;
  }
  if (result.error && !result.data) {
    return (
      <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <p className="text-sm font-medium text-ink">没能取到节点</p>
        <p className="max-w-md text-xs leading-relaxed text-ink-3">{errorMessage(result.error)}</p>
        <Button size="sm" icon={RotateCcw} onClick={() => void result.refetch()}>
          重试
        </Button>
      </Card>
    );
  }
  const data = result.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="tnum font-display text-[34px] leading-none text-ink">
              {data ? data.after.count : <Skeleton className="h-8 w-12" />}
            </span>
            <span className="text-sm text-ink-2">个节点</span>
          </div>
          <p className="mt-1 text-xs text-ink-3">
            {data
              ? data.before.count !== data.after.count
                ? `原始 ${data.before.count} 个，经处理流程后剩 ${data.after.count} 个`
                : '已应用处理流程'
              : '正在读取…'}
          </p>
        </div>
        <SearchInput value={query} onChange={setQuery} aria-label="搜索节点名称" placeholder="搜索节点名称" className="w-full sm:w-64" />
      </div>
      {data && <MemberErrors errors={data.memberErrors} />}
      {data && data.issues.length > 0 && <IssueList issues={data.issues} limit={3} />}
      {regions.length > 1 && (
        <SegmentedControl
          label="按地区筛选"
          size="sm"
          value={region === 'all' ? 'all' : (region ?? '__other__')}
          onChange={(next) => setRegion(next === 'all' ? 'all' : next === '__other__' ? null : next)}
          className="flex-wrap"
          options={[{ region: 'all' as const, zh: '全部', count: names.length }, ...regions].map((r) => ({
            value: r.region === 'all' ? 'all' : (r.region ?? '__other__'),
            label: (
              <span className="inline-flex items-center gap-1">
                {r.region !== 'all' && <Flag region={r.region} size={13} />}
                <span>{r.zh}</span>
                <span className="tnum text-ink-3">{r.count}</span>
              </span>
            ),
          }))}
        />
      )}
      <Card className="p-2">
        {!data ? (
          <div className="grid gap-2 p-2 sm:grid-cols-2">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : (
          <NodeList names={filtered} query={query} className="sm:grid sm:grid-cols-2 sm:gap-x-4" />
        )}
      </Card>
      {data?.after.truncated && (
        <p className="text-xs text-ink-3">只列出前 {data.after.names.length} 个，共 {data.after.count} 个节点。</p>
      )}
    </div>
  );
}

/* ─── usage tab ──────────────────────────────────────────────────────── */

export function UsagePanel({ kind, id }: { kind: 'subscription' | 'collection'; id: string }) {
  const usage = useSourceUsage(kind, id);
  const { data: profiles } = useProfiles();
  if (usage.isLoading) return <Skeleton className="h-32 rounded-xl" />;
  if (usage.error) {
    return (
      <Card className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-ink-2">
        {errorMessage(usage.error)}
        <Button size="sm" icon={RotateCcw} onClick={() => void usage.refetch()}>
          重试
        </Button>
      </Card>
    );
  }
  const data = usage.data ?? { profiles: [], collections: [] };
  if (data.profiles.length === 0 && data.collections.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title="还没有地方用到它"
        description={kind === 'subscription' ? '把它绑定到配置文件，或加入聚合订阅后，就会出现在这里。' : '把它绑定到配置文件后，就会出现在这里。'}
        actions={
          <Button asChild size="sm" variant="secondary">
            <Link href="/profiles">去配置文件</Link>
          </Button>
        }
      />
    );
  }
  const usageItems = [
    ...data.profiles.map((p) => {
      const profile = profiles?.find((x) => x.id === p.id);
      const direct = profile?.source && 'id' in profile.source && profile.source.id === id;
      return {
        value: `profile:${p.id}`,
        label: `配置文件：${profile?.display_name || p.name} (${p.name}) · ${direct ? '直接绑定' : '经由聚合订阅'}`,
      };
    }),
    ...data.collections.map((c) => ({
      value: `pool:${c.id}`,
      label: `聚合订阅：${c.name}`,
    })),
  ];
  return (
    <DataView
      label="使用情况"
      summary={`${data.profiles.length} 个配置文件，${data.collections.length} 个聚合订阅`}
      items={usageItems}
      className="flex flex-col gap-6"
    >
      {data.profiles.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-ink">配置文件 · {data.profiles.length}</h3>
          <p className="text-xs text-ink-3">这些配置文件的节点来自它（直接绑定或经由聚合订阅）；修改它会影响它们的最终配置。</p>
          <Card className="divide-y divide-line">
            {data.profiles.map((p) => {
              const profile = profiles?.find((x) => x.id === p.id);
              const direct = profile?.source && 'id' in profile.source && profile.source.id === id;
              const title = profile?.display_name || p.name;
              return (
                <UiButton
                  key={p.id}
                  render={<Link href={`/p/${encodeURIComponent(p.name)}`} />}
                  aria-label={`打开配置文件「${title}」`}
                  className="group flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60"
                >
                  <Monogram name={title} colorKey={p.id} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{title}</div>
                    <div className="font-mono text-[11px] text-ink-3">{p.name}</div>
                  </div>
                  <span className="text-xs text-ink-3">{direct ? '直接绑定' : '经由聚合订阅'}</span>
                  <ArrowUpRight size={14} className="text-ink-4 group-hover:text-ink-2" />
                </UiButton>
              );
            })}
          </Card>
        </section>
      )}
      {data.collections.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-ink">聚合订阅 · {data.collections.length}</h3>
          <Card className="divide-y divide-line">
            {data.collections.map((c) => (
              <UiButton
                key={c.id}
                render={<Link href={`/pools/${c.id}`} />}
                aria-label={`打开聚合订阅「${c.name}」`}
                className="group flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60"
              >
                <span className="flex size-7 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2">
                  <Boxes size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{c.name}</span>
                <ArrowUpRight size={14} className="text-ink-4 group-hover:text-ink-2" />
              </UiButton>
            ))}
          </Card>
        </section>
      )}
    </DataView>
  );
}

/* ─── distribution tab ───────────────────────────────────────────────── */

export function useSubBase(): string | null {
  const profile = useActiveProfile();
  const { data } = useMeta(profile?.id ?? null);
  return data?.subBase ?? null;
}

export function DistributionPanel({ path, label }: { path: (subBase: string) => string; label: string }) {
  const subBase = useSubBase();
  const [qr, setQr] = useState<'clash' | 'base64'>('clash');
  if (!subBase) return <Skeleton className="h-40 rounded-xl" />;
  const url = path(subBase);
  const links = [
    { key: 'clash' as const, label: 'Clash / Mihomo', hint: '只含节点（proxies）', url, icon: FileCode2 },
    { key: 'base64' as const, label: '通用 Base64', hint: 'Shadowrocket、v2rayN 等', url: withBase64(url), icon: QrCode },
  ];
  const current = links.find((l) => l.key === qr) ?? links[0];
  return (
    <div className="grid gap-6 md:grid-cols-[1fr_auto]">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm leading-relaxed text-ink-2">
          直接分发「{label}」处理后的节点，不含策略组和分流规则。适合给别的工具当节点来源；要完整配置请分发配置文件的链接。
        </p>
        {links.map((link) => (
          <LinkRow
            key={link.key}
            label={link.label}
            hint={link.hint}
            url={link.url}
            icon={link.icon}
            active={qr === link.key}
            onShowQr={() => setQr(link.key)}
          />
        ))}
        <p className="text-[11px] leading-relaxed text-ink-3">链接内含访问令牌，请勿公开分享。改标识会让旧链接失效。</p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <QrImage text={current.url} size={176} />
        <span className="text-xs text-ink-3">扫码导入 · {current.label}</span>
      </div>
    </div>
  );
}

/* ─── remote fetch fields (create dialog + settings) ─────────────────── */

export function HeaderRowsEditor({
  rows,
  onChange,
  errors,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  errors: Record<string, string>;
}) {
  const set = (id: string, patch: Partial<HeaderRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={row.id} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Input
              mono
              inputSize="sm"
              aria-label={`请求头 ${index + 1} 名称`}
              placeholder="名称，如 Authorization"
              value={row.name}
              invalid={!!errors[row.id]}
              onChange={(e) => set(row.id, { name: e.target.value })}
              className="w-[42%]"
            />
            <Input
              mono
              inputSize="sm"
              aria-label={`请求头 ${index + 1} 值`}
              placeholder="值"
              value={row.value}
              onChange={(e) => set(row.id, { value: e.target.value })}
              className="min-w-0 flex-1"
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={rows.length > 1 ? Trash2 : X}
              aria-label={`移除请求头 ${index + 1}`}
              onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
            />
          </div>
          {errors[row.id] && <span className="text-xs text-bad">{errors[row.id]}</span>}
        </div>
      ))}
      <div>
        <Button size="xs" variant="subtle" icon={Plus} onClick={() => onChange([...rows, { id: newId(), name: '', value: '' }])}>
          添加请求头
        </Button>
      </div>
    </div>
  );
}

export function PolicyPicker({ value, onChange }: { value: FailurePolicy; onChange: (value: FailurePolicy) => void }) {
  return (
    <RadioGroup
      aria-label="拉取失败时"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as FailurePolicy);
      }}
      className="grid gap-2 sm:grid-cols-2"
    >
      {POLICY_OPTIONS.map((option) => (
        <label
          key={option.value}
          className={cn(
            'flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
            'has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-accent',
            option.value === value
              ? 'border-accent-line bg-accent-soft/60'
              : 'border-line bg-surface hover:border-line-strong',
          )}
        >
          <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Radio
              value={option.value}
              className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface outline-none data-checked:border-accent data-checked:bg-accent"
            >
              <RadioIndicator className="size-1.5 rounded-full bg-accent-ink" />
            </Radio>
            {option.title}
          </span>
          <span className="text-xs leading-relaxed text-ink-3">{option.description}</span>
        </label>
      ))}
    </RadioGroup>
  );
}
