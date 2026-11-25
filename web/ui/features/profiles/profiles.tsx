'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  ArrowUpRight,
  CopyPlus,
  EyeOff,
  LayoutTemplate,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  RadioTower,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { partitionProfilesByKind } from '@/lib/profiles/kind';
import { DataView } from '@/ui/agent';
import { errorMessage } from '@/ui/data/api';
import { keys, refreshProfiles, useDevices, useGroups, useProfiles, useRuleSummary } from '@/ui/data/hooks';
import { getQueryData } from '@/ui/data/query';
import type { Profile, PublicDevice } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { formatCount } from '@/ui/lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Menu,
  Monogram,
  Numeral,
  Skeleton,
  Tooltip,
  confirmAction,
  notify,
  type MenuEntry,
} from '@/ui/primitives';
import { Block, Page, PageHeader } from '@/ui/shell/page';
import { profileTitle, useSourceLabel } from '@/ui/shell/profile-switcher';
import { profilePath, useActiveProfile } from '@/ui/shell/scope';
import { assignLineColors, policyColor } from '@/ui/viz/lines';
import { CreateProfileDialog, type CreateSeed } from './create-dialog';
import { EditProfileSheet } from './edit-sheet';
import { DEFAULT_PROFILE, profileApi, uncacheProfile } from './model';

/* ─── page ───────────────────────────────────────────────────────────── */

export function ProfilesPage() {
  const profiles = useProfiles();
  const active = useActiveProfile();
  const [create, setCreate] = useState<{ seed: CreateSeed; open: boolean; n: number } | null>(null);
  const [editing, setEditing] = useState<{ profile: Profile; open: boolean; n: number } | null>(null);

  const { normal, templates } = useMemo(() => partitionProfilesByKind(profiles.data ?? []), [profiles.data]);

  const openCreate = useCallback((seed: CreateSeed = {}) => {
    setCreate((current) => ({ seed, open: true, n: (current?.n ?? 0) + 1 }));
  }, []);
  const openEdit = (profile: Profile) => setEditing((current) => ({ profile, open: true, n: (current?.n ?? 0) + 1 }));
  const closeEdit = () => setEditing((current) => current && { ...current, open: false });

  const remove = async (profile: Profile) => {
    const title = profileTitle(profile);
    const devices = getQueryData<PublicDevice[]>(keys.scoped(profile.id, 'devices'))?.length ?? 0;
    const template = profile.kind === 'template';
    const ok = await confirmAction({
      title: `删除「${title}」？`,
      description: template
        ? '模版里的策略组、规则和基础配置会一起删除。之前从它创建的配置文件不受影响。此操作无法撤销。'
        : `它的策略组、规则、基础配置${devices ? `和 ${devices} 台设备` : ''}会一起删除，订阅链接 …/${profile.name} 随即失效。共享的订阅源、聚合订阅和规则集不受影响。此操作无法撤销。`,
      confirmText: '确认删除',
      confirmHint: `删除${template ? '模版' : '配置文件'}「${title}」`,
      tone: 'danger',
    });
    if (!ok) return false;
    try {
      await profileApi.remove(profile.id);
      uncacheProfile(profile.id);
      refreshProfiles();
      notify.success(`已删除「${title}」`);
      return true;
    } catch (error) {
      notify.error(error, '删除失败');
      return false;
    }
  };

  const actions: CardActions = {
    edit: openEdit,
    derive: (profile) =>
      openCreate({ start: profile.kind === 'template' ? 'template' : 'copy', fromId: profile.id }),
    remove: (profile) => void remove(profile),
  };

  return (
    <Page>
      <PageHeader
        title="配置文件"
        description="一份配置文件就是一套完整的客户端配置：有自己的策略组、规则、基础配置和设备；节点来源可以在多份之间共享。"
        actions={
          <Button variant="primary" icon={Plus} onClick={() => openCreate()}>
            新建配置文件
          </Button>
        }
      />
      <Suspense fallback={null}>
        <NewParamListener onNew={openCreate} />
      </Suspense>

      {profiles.error && !profiles.data ? (
        <Card className="flex flex-col items-start gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <TriangleAlert size={16} className="shrink-0 text-bad" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">配置文件加载失败</div>
            <p className="mt-0.5 text-xs text-ink-3">{errorMessage(profiles.error)}</p>
          </div>
          <Button size="sm" icon={RefreshCw} loading={profiles.isValidating} onClick={() => void profiles.refetch()}>
            重试
          </Button>
        </Card>
      ) : (
        <div className="flex flex-col gap-10">
          <Block
            title={
              <span className="flex items-baseline gap-2">
                配置文件
                {profiles.data && <span className="tnum text-xs font-normal text-ink-3">{normal.length}</span>}
              </span>
            }
            description="卡片顶部的色条是这份配置的线路构成：每段代表一个策略组，越长说明指向它的规则越多。"
          >
            <DataView
              label="配置文件列表"
              summary={`共 ${normal.length} 份配置文件`}
              items={normal.map((p) => ({
                value: p.id,
                label: `${profileTitle(p)} (${p.name})${active?.id === p.id ? ' · 当前' : ''}${p.notes ? ` · ${p.notes}` : ''}`,
              }))}
            >
              <div className="grid gap-4 sm:grid-cols-2 @4xl/main:grid-cols-3">
                {!profiles.data ? (
                  [0, 1, 2].map((i) => <CardSkeleton key={i} />)
                ) : (
                  <>
                    {normal.map((profile) => (
                      <ProfileCard
                        key={profile.id}
                        profile={profile}
                        current={active?.id === profile.id}
                        actions={actions}
                      />
                    ))}
                    <button
                      type="button"
                      data-agent-hidden
                      onClick={() => openCreate()}
                      className="group flex min-h-[208px] animate-rise flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong px-6 text-center transition-colors hover:border-ink-4 hover:bg-surface/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      style={{ animationDelay: `${normal.length * 50}ms` }}
                    >
                      <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface text-ink-2 shadow-xs transition-transform group-hover:scale-105">
                        <Plus size={18} strokeWidth={1.75} />
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-ink">新建配置文件</span>
                        <span className="mt-0.5 block text-xs text-ink-3">从模版、空白骨架或现有配置开始</span>
                      </span>
                    </button>
                  </>
                )}
              </div>
            </DataView>
          </Block>

          <Block
            title={
              <span className="flex items-baseline gap-2">
                模版
                {profiles.data && <span className="tnum text-xs font-normal text-ink-3">{templates.length}</span>}
              </span>
            }
            description="模版不对外分发，只用来当新建配置文件的起点：拷贝一次，之后两边各自独立。"
          >
            {!profiles.data ? (
              <div className="grid gap-4 sm:grid-cols-2 @4xl/main:grid-cols-3">
                <CardSkeleton dashed />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line-strong">
                <EmptyState
                  compact
                  icon={LayoutTemplate}
                  title="还没有模版"
                  description="把一份调好的配置文件转为模版（编辑 → 类型），或者新建时直接选「模版」。"
                  actions={
                    <Button size="sm" icon={Plus} onClick={() => openCreate({ start: 'blank', kind: 'template' })}>
                      新建模版
                    </Button>
                  }
                />
              </div>
            ) : (
              <DataView
                label="配置模版列表"
                summary={`共 ${templates.length} 个模版`}
                items={templates.map((p) => ({
                  value: p.id,
                  label: `${profileTitle(p)} (${p.name})${p.notes ? ` · ${p.notes}` : ''}`,
                }))}
              >
                <div className="grid gap-4 sm:grid-cols-2 @4xl/main:grid-cols-3">
                  {templates.map((profile, index) => (
                    <TemplateCard key={profile.id} profile={profile} actions={actions} index={index} />
                  ))}
                </div>
              </DataView>
            )}
          </Block>
        </div>
      )}

      {create && (
        <CreateProfileDialog
          key={create.n}
          seed={create.seed}
          open={create.open}
          onOpenChange={(open) => setCreate((current) => current && { ...current, open })}
        />
      )}
      {editing && (
        <EditProfileSheet
          key={editing.n}
          profile={editing.profile}
          open={editing.open}
          onOpenChange={(open) => (open ? undefined : closeEdit())}
          onDelete={(profile) =>
            void remove(profile).then((removed) => {
              if (removed) closeEdit();
            })
          }
        />
      )}
    </Page>
  );
}

/** `?new=1` (from the profile switcher / palette) opens the create dialog once. */
function NewParamListener({ onNew }: { onNew: () => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const wantsNew = params.get('new') === '1';
  useEffect(() => {
    if (!wantsNew) return;
    onNew();
    router.replace('/profiles', { scroll: false });
  }, [wantsNew, onNew, router]);
  return null;
}

/* ─── cards ──────────────────────────────────────────────────────────── */

interface CardActions {
  edit: (profile: Profile) => void;
  derive: (profile: Profile) => void;
  remove: (profile: Profile) => void;
}

function menuItems(profile: Profile, actions: CardActions, open: () => void): MenuEntry[] {
  const isDefault = profile.name === DEFAULT_PROFILE;
  const template = profile.kind === 'template';
  return [
    { label: '打开', icon: ArrowUpRight, onSelect: open },
    { label: '编辑', icon: Pencil, onSelect: () => actions.edit(profile) },
    { label: template ? '用它新建配置文件' : '从它新建', icon: CopyPlus, onSelect: () => actions.derive(profile) },
    'separator',
    {
      label: '删除',
      icon: Trash2,
      tone: 'danger',
      disabled: isDefault,
      hint: isDefault ? '默认配置不可删' : undefined,
      onSelect: () => actions.remove(profile),
    },
  ];
}

/** Counts + the profile's route mix, from the cached per-profile reads. */
function useProfileShape(profileId: string) {
  const groups = useGroups(profileId);
  const summary = useRuleSummary(profileId);
  const devices = useDevices(profileId);
  const segments = useMemo(() => {
    if (!groups.data || !summary.data) return null;
    // Same colour assignment as the app-wide line colours: groups that rules use first, then by rank.
    const ranked = groups.data
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((g) => g.name);
    const policies = summary.data.policies;
    const colors = assignLineColors([...ranked.filter((n) => policies[n]), ...ranked.filter((n) => !policies[n])]);
    return Object.entries(policies)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([policy, count]) => ({ policy, count, color: policyColor(colors, policy) }));
  }, [groups.data, summary.data]);
  return {
    groups: groups.data?.length,
    rules: summary.data?.active,
    disabledRules: summary.data?.disabled ?? 0,
    devices: devices.data?.length,
    segments,
    error: groups.error ?? summary.error,
  };
}

function RouteStrip({ segments, muted }: { segments: ReturnType<typeof useProfileShape>['segments']; muted?: boolean }) {
  if (!segments) return <div className="skeleton h-1 w-full rounded-none" />;
  if (segments.length === 0) return <div className="h-1 w-full bg-surface-3" />;
  return (
    <div className={cn('flex h-1 w-full gap-[2px]', muted && 'opacity-45')} aria-hidden>
      {segments.map((segment) => (
        <span
          key={segment.policy}
          title={`${segment.policy} · ${segment.count} 条规则`}
          className="h-full min-w-1"
          style={{ flexGrow: segment.count, background: segment.color }}
        />
      ))}
    </div>
  );
}

function SourceLine({ profile }: { profile: Profile }) {
  const label = useSourceLabel(profile);
  const unbound = !profile.source || profile.source.type === 'none';
  const Icon = unbound ? Unplug : RadioTower;
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5 text-xs', unbound ? 'text-ink-3' : 'text-ink-2')}>
      <Icon size={13} strokeWidth={1.75} className="shrink-0 text-ink-3" />
      <span className="truncate">{label || ' '}</span>
    </div>
  );
}

function ProfileCard({ profile, current, actions }: { profile: Profile; current: boolean; actions: CardActions }) {
  const router = useRouter();
  const shape = useProfileShape(profile.id);
  const title = profileTitle(profile);
  const href = profilePath(profile.name);
  return (
    <Card
      as="article"
      interactive
      className="group relative flex min-h-[208px] animate-rise flex-col overflow-hidden"
    >
      <RouteStrip segments={shape.segments} />
      <div className="flex items-start gap-3 px-4 pt-4">
        <Monogram name={title} colorKey={profile.id} size={40} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <UiButton
              render={<Link href={href} />}
              aria-label={`打开「${title}」`}
              className="truncate text-[15px] font-semibold tracking-tight text-ink outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:shadow-[var(--ring)]"
            >
              {title}
            </UiButton>
            {current && (
              <Tooltip content="侧边栏当前正在编辑的配置文件">
                <span className="relative z-10">
                  <Badge tone="accent">当前</Badge>
                </span>
              </Tooltip>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{profile.name}</div>
        </div>
        <div className="relative z-10 -mr-1.5 -mt-1 flex items-center">
          <Tooltip content="编辑">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={Pencil}
              aria-label={`编辑「${title}」`}
              onClick={() => actions.edit(profile)}
            />
          </Tooltip>
          <Menu
            trigger={<Button variant="ghost" size="sm" iconOnly icon={MoreHorizontal} aria-label={`「${title}」的更多操作`} />}
            items={menuItems(profile, actions, () => router.push(href))}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5 px-4 pb-4 pt-3">
        <SourceLine profile={profile} />
        {profile.notes ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-ink-3">{profile.notes}</p>
        ) : null}
      </div>
      <dl className="mt-auto grid grid-cols-3 divide-x divide-line border-t border-line">
        <Stat label="策略组" value={shape.groups} />
        <Stat
          label="规则"
          value={shape.rules}
          hint={shape.disabledRules ? `另有 ${shape.disabledRules} 条已停用` : undefined}
        />
        <Stat label="设备" value={shape.devices} />
      </dl>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | undefined; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3" title={hint}>
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd>
        {value === undefined ? (
          <Skeleton className="h-[22px] w-8" />
        ) : (
          <Numeral value={formatCount(value)} className="text-[24px]" />
        )}
      </dd>
    </div>
  );
}

function TemplateCard({ profile, actions, index }: { profile: Profile; actions: CardActions; index: number }) {
  const router = useRouter();
  const shape = useProfileShape(profile.id);
  const title = profileTitle(profile);
  const href = profilePath(profile.name);
  return (
    <article
      className="group relative flex min-h-[176px] animate-rise flex-col overflow-hidden rounded-xl border border-dashed border-line-strong bg-surface/50 transition-[border-color,background-color] duration-200 hover:border-ink-4 hover:bg-surface"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <RouteStrip segments={shape.segments} muted />
      <div className="flex items-start gap-3 px-4 pt-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[28%] border border-dashed border-line-strong bg-surface-2 text-ink-3">
          <LayoutTemplate size={17} strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <UiButton
              render={<Link href={href} />}
              aria-label={`打开「${title}」`}
              className="truncate text-[15px] font-semibold tracking-tight text-ink outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:shadow-[var(--ring)]"
            >
              {title}
            </UiButton>
            <Badge tone="outline" icon={EyeOff} title="模版的订阅链接返回 404">
              不对外分发
            </Badge>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{profile.name}</div>
        </div>
        <div className="relative z-10 -mr-1.5 -mt-1">
          <Menu
            trigger={<Button variant="ghost" size="sm" iconOnly icon={MoreHorizontal} aria-label={`「${title}」的更多操作`} />}
            items={menuItems(profile, actions, () => router.push(href))}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5 px-4 pb-4 pt-3">
        <SourceLine profile={profile} />
        {profile.notes ? <p className="line-clamp-2 text-xs leading-relaxed text-ink-3">{profile.notes}</p> : null}
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-dashed border-line-strong px-4 py-2.5">
        <span className="tnum flex items-center gap-1.5 text-xs text-ink-3">
          <Layers size={12} strokeWidth={1.75} />
          {shape.groups === undefined || shape.rules === undefined ? (
            <Skeleton className="h-3 w-24" />
          ) : (
            `${shape.groups} 个策略组 · ${shape.rules} 条规则`
          )}
        </span>
        <Button
          size="sm"
          icon={CopyPlus}
          className="relative z-10"
          onClick={() => actions.derive(profile)}
        >
          用它新建
        </Button>
      </div>
    </article>
  );
}

function CardSkeleton({ dashed }: { dashed?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-h-[208px] flex-col overflow-hidden rounded-xl border',
        dashed ? 'min-h-[176px] border-dashed border-line-strong' : 'border-line bg-surface shadow-xs',
      )}
    >
      <Skeleton className="h-1 w-full rounded-none" />
      <div className="flex items-center gap-3 px-4 pt-4">
        <Skeleton className="size-10 rounded-[28%]" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 pt-4">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-3 w-48" />
      </div>
      <div className="mt-auto grid grid-cols-3 gap-4 border-t border-line px-4 py-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-2.5 w-10" />
            <Skeleton className="h-5 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}
