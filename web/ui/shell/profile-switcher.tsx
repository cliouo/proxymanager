'use client';

import { navigateWithGuard } from '@/ui/features/groups/guard';

import { useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, LayoutTemplate, Plus, Settings2 } from 'lucide-react';
import { useProfiles, usePools, useSources } from '@/ui/data/hooks';
import type { Profile } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Monogram, Popover } from '@/ui/primitives';
import { profilePath, useActiveProfile } from './scope';
import { intentProps } from './prefetch';

export function profileTitle(profile: Profile): string {
  return profile.display_name?.trim() || profile.name;
}

export function useSourceLabel(profile: Profile | null): string {
  const { data: sources } = useSources();
  const { data: pools } = usePools();
  if (!profile) return '';
  const source = profile.source;
  if (!source || source.type === 'none') return '未绑定节点来源';
  if (source.type === 'subscription') {
    const sub = sources?.find((s) => s.id === source.id);
    return sub ? `订阅 · ${sub.display_name || sub.name}` : '订阅源';
  }
  const pool = pools?.find((p) => p.id === source.id);
  return pool ? `聚合 · ${pool.name}` : '聚合订阅';
}

export function ProfileSwitcher({ collapsed }: { collapsed?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: profiles } = useProfiles();
  const active = useActiveProfile();
  const [open, setOpen] = useState(false);
  const sourceLabel = useSourceLabel(active);

  const { normal, templates } = useMemo(() => {
    const list = profiles ?? [];
    return {
      normal: list.filter((p) => p.kind !== 'template'),
      templates: list.filter((p) => p.kind === 'template'),
    };
  }, [profiles]);

  // Keep the current section when switching profiles (ids differ, so drop deeper segments).
  const targetHref = (profile: Profile) => {
    const section = pathname.match(/^\/p\/[^/]+\/([^/]+)/)?.[1];
    const keep = section && ['groups', 'rules', 'devices', 'chains', 'base', 'output'].includes(section) ? section : undefined;
    return profilePath(profile.name, keep);
  };
  const go = (profile: Profile) => {
    void navigateWithGuard(() => {
      setOpen(false);
      router.push(targetHref(profile));
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      sideOffset={6}
      className="w-[280px] p-0"
      trigger={
        <button
          type="button"
          className={cn(
            'group flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface text-left shadow-xs transition hover:border-line-strong',
            collapsed ? 'justify-center p-1.5' : 'px-2 py-1.5',
          )}
        >
          {active ? (
            <Monogram name={profileTitle(active)} colorKey={active.id} size={28} />
          ) : (
            <span className="skeleton size-7 rounded-[28%]" />
          )}
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-ink">
                  {active ? profileTitle(active) : '…'}
                  {active?.kind === 'template' && (
                    <span className="rounded bg-surface-3 px-1 text-[10px] font-medium text-ink-3">模版</span>
                  )}
                </span>
                <span className="block truncate text-[11px] text-ink-3">{sourceLabel || ' '}</span>
              </span>
              <ChevronsUpDown size={14} className="shrink-0 text-ink-3 group-hover:text-ink-2" />
            </>
          )}
        </button>
      }
    >
      <Command loop className="flex flex-col">
        <div className="border-b border-line p-1.5">
          <Command.Input
            autoFocus
            placeholder="切换配置文件…"
            className="h-8 w-full rounded-md bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-4"
          />
        </div>
        <Command.List className="max-h-[320px] overflow-y-auto p-1">
          <Command.Empty className="px-2 py-6 text-center text-xs text-ink-3">没有匹配的配置文件</Command.Empty>
          <Command.Group
            heading="配置文件"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3"
          >
            {normal.map((profile) => (
              <ProfileRow key={profile.id} profile={profile} active={active?.id === profile.id} onSelect={() => go(profile)} intent={intentProps(targetHref(profile))} />
            ))}
          </Command.Group>
          {templates.length > 0 && (
            <Command.Group
              heading="模版"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3"
            >
              {templates.map((profile) => (
                <ProfileRow key={profile.id} profile={profile} active={active?.id === profile.id} onSelect={() => go(profile)} intent={intentProps(targetHref(profile))} template />
              ))}
            </Command.Group>
          )}
        </Command.List>
        <div className="flex gap-1 border-t border-line p-1">
          <button
            type="button"
            onClick={() => {
              void navigateWithGuard(() => {
                setOpen(false);
                router.push('/profiles?new=1');
              });
            }}
            className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <Plus size={14} /> 新建配置文件
          </button>
          <button
            type="button"
            onClick={() => {
              void navigateWithGuard(() => {
                setOpen(false);
                router.push('/profiles');
              });
            }}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <Settings2 size={14} /> 管理
          </button>
        </div>
      </Command>
    </Popover>
  );
}

function ProfileRow({
  profile,
  active,
  onSelect,
  template,
  intent,
}: {
  profile: Profile;
  active: boolean;
  onSelect: () => void;
  template?: boolean;
  intent?: ReturnType<typeof intentProps>;
}) {
  return (
    <Command.Item
      {...intent}
      value={`${profile.name} ${profile.display_name ?? ''}`}
      onSelect={onSelect}
      className="flex h-10 cursor-default items-center gap-2.5 rounded-md px-2 text-sm text-ink data-[selected=true]:bg-surface-2"
    >
      {template ? (
        <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-line-strong text-ink-3">
          <LayoutTemplate size={13} />
        </span>
      ) : (
        <Monogram name={profileTitle(profile)} colorKey={profile.id} size={24} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{profileTitle(profile)}</span>
        <span className="block truncate font-mono text-[10.5px] text-ink-3">{profile.name}</span>
      </span>
      {active && <Check size={14} className="text-accent" />}
    </Command.Item>
  );
}
