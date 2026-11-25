'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ui-sdk/react/command';
import { Dialog, DialogBackdrop, DialogContent, DialogDescription, DialogTitle } from '@ui-sdk/react/dialog';
import { useTheme } from 'next-themes';
import {
  ArrowRight,
  BookMarked,
  Copy,
  CornerDownLeft,
  Layers,
  ListPlus,
  Moon,
  MonitorSmartphone,
  Plus,
  QrCode,
  RadioTower,
  Search,
  Sparkles,
  Sun,
  Waypoints,
} from 'lucide-react';
import { useDashboard, useDevices, useGroups, usePools, useProfiles, useRuleSets, useSources } from '@/ui/data/hooks';
import { navigateWithGuard } from '@/ui/features/groups/guard';
import { cn } from '@/ui/lib/cn';
import { copyText, Kbd, notify } from '@/ui/primitives';
import { useLineColors, LineDot } from '@/ui/viz/lines';
import { ALL_NAV } from './nav';
import { profilePath, useActiveProfile } from './scope';
import { openAssistant, openShare, setUi, useUi } from './state';
import { profileTitle } from './profile-switcher';
import { namingCommand } from './naming-command';

const groupHeadingClass = 'px-2 pb-1.5 pt-3 text-[11px] font-medium text-ink-3';

function Item({
  icon,
  children,
  hint,
  onSelect,
  value,
  label,
  keywords,
}: {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  value: string;
  label?: string;
  keywords?: string[];
}) {
  return (
    <CommandItem
      value={value}
      label={label}
      keywords={keywords}
      onSelect={() => onSelect()}
      className="group flex h-10 cursor-default items-center gap-3 rounded-lg px-2.5 text-sm text-ink data-highlighted:bg-surface-2"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink-2 group-data-highlighted:border-line-strong">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-ink-3">{hint}</span>}
      <CornerDownLeft size={13} className="shrink-0 text-ink-4 opacity-0 group-data-highlighted:opacity-100" />
    </CommandItem>
  );
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const [search, setSearch] = useState('');
  const profile = useActiveProfile();
  const pid = open ? (profile?.id ?? null) : null;
  const { data: profiles } = useProfiles();
  const { data: groups } = useGroups(pid);
  const { data: devices } = useDevices(pid);
  const { data: sources } = useSources();
  const { data: pools } = usePools();
  const { data: ruleSets } = useRuleSets(pid);
  const { data: dashboard } = useDashboard(pid);
  const { color } = useLineColors();

  const close = () => {
    setUi({ paletteOpen: false });
    setSearch('');
  };
  const go = (href: string) => {
    void navigateWithGuard(() => {
      close();
      router.push(href);
    }, href);
  };
  const path = (sub?: string) => (profile ? profilePath(profile.name, sub) : '/');

  const sortedGroups = useMemo(() => (groups ?? []).slice().sort((a, b) => a.rank - b.rank), [groups]);
  const trimmedSearch = search.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setUi({ paletteOpen: true }) : close())}>
      <DialogBackdrop className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-open:animate-fade-in" />
      <DialogContent
        className={cn(
          'fixed left-1/2 top-[12vh] z-50 m-0 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl outline-none',
          'data-open:animate-pop',
        )}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">跳转页面、搜索资源或执行快捷操作</DialogDescription>
        <Command loop query={search} onQueryChange={(next) => setSearch(next)}>
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search size={17} className="shrink-0 text-ink-3" />
            <CommandInput
              autoFocus
              aria-label="命令面板搜索"
              placeholder="跳转页面、搜索策略组 / 订阅源 / 设备，或执行操作…"
              className="h-14 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
            <Kbd>Esc</Kbd>
          </div>
          <CommandEmpty className="flex flex-col items-center gap-2 py-12 text-sm text-ink-3 empty:p-0">
            <Search size={20} className="text-ink-4" />
            没有找到「{search}」
          </CommandEmpty>
          <CommandList className="max-h-[min(460px,60vh)] overflow-y-auto pb-2 scroll-fade-y">
            {trimmedSearch.length > 0 && profile && (
              <CommandGroup className="px-1.5">
                <CommandGroupLabel className={groupHeadingClass}>在规则中搜索</CommandGroupLabel>
                <Item
                  value={`search-rules ${trimmedSearch}`}
                  keywords={[trimmedSearch]}
                  icon={<Search size={13} />}
                  onSelect={() => go(`${path('rules')}?q=${encodeURIComponent(trimmedSearch)}`)}
                >
                  搜索规则：<span className="font-mono text-[13px]">{trimmedSearch}</span>
                </Item>
              </CommandGroup>
            )}

            <CommandGroup className="px-1.5">
              <CommandGroupLabel className={groupHeadingClass}>操作</CommandGroupLabel>
              <Item
                value="new-rule"
                label="新建规则"
                keywords={['new rule', '添加规则']}
                icon={<ListPlus size={13} />}
                hint="规则"
                onSelect={() => go(`${path('rules')}?compose=1`)}
              >
                新建规则
              </Item>
              <Item
                value="new-group"
                label="新建策略组"
                keywords={['new group']}
                icon={<Plus size={13} />}
                hint="策略组"
                onSelect={() => go(`${path('groups')}?new=1`)}
              >
                新建策略组
              </Item>
              <Item
                value="add-source"
                label="添加订阅源"
                keywords={['add source']}
                icon={<RadioTower size={13} />}
                hint="节点来源"
                onSelect={() => go('/sources?new=1')}
              >
                添加订阅源
              </Item>
              {dashboard?.meta.subscriptionUrl && (
                <Item
                  value="copy-subscription-link"
                  label="复制订阅链接"
                  keywords={['copy subscription link']}
                  icon={<Copy size={13} />}
                  hint={profile ? profileTitle(profile) : undefined}
                  onSelect={() => {
                    close();
                    void copyText(dashboard.meta.subscriptionUrl).then((ok) => ok && notify.success('订阅链接已复制'));
                  }}
                >
                  复制订阅链接
                </Item>
              )}
              <Item
                value="share-qr"
                label="订阅链接与二维码"
                keywords={['share', 'qr', '二维码', '分享', '订阅']}
                icon={<QrCode size={13} />}
                onSelect={() => {
                  close();
                  openShare();
                }}
              >
                订阅链接与二维码
              </Item>
              <Item
                value="ai-assistant"
                label={trimmedSearch ? `问 AI：${trimmedSearch}` : '打开 AI 助手'}
                keywords={['ai', 'assistant', '助手', ...(trimmedSearch ? [trimmedSearch] : [])]}
                icon={<Sparkles size={13} className="text-accent" />}
                hint="⌘J"
                onSelect={() => {
                  close();
                  openAssistant(trimmedSearch || undefined);
                }}
              >
                {trimmedSearch ? <>问 AI：{trimmedSearch}</> : '打开 AI 助手'}
              </Item>
              <Item
                value="toggle-theme"
                label={`切换到${resolvedTheme === 'dark' ? '浅色' : '深色'}主题`}
                keywords={['toggle theme', '切换主题', '深色', '浅色']}
                icon={resolvedTheme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
                onSelect={() => {
                  close();
                  setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
                }}
              >
                切换到{resolvedTheme === 'dark' ? '浅色' : '深色'}主题
              </Item>
            </CommandGroup>

            <CommandGroup className="px-1.5">
              <CommandGroupLabel className={groupHeadingClass}>跳转</CommandGroupLabel>
              {ALL_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <Item
                    key={item.id}
                    value={`nav-${item.id}`}
                    label={item.label}
                    keywords={[item.id, item.hint ?? '']}
                    icon={<Icon size={13} />}
                    hint={item.hint}
                    onSelect={() => go(item.scoped ? path(item.href || undefined) : item.href)}
                  >
                    {item.label}
                  </Item>
                );
              })}
            </CommandGroup>

            {sortedGroups.length > 0 && (
              <CommandGroup className="px-1.5">
                <CommandGroupLabel className={groupHeadingClass}>策略组</CommandGroupLabel>
                {sortedGroups.map((group) => (
                  <Item
                    key={group.id}
                    value={`group-${group.id}`}
                    label={group.name}
                    keywords={['group', group.type]}
                    icon={<LineDot color={color(group.name)} size={9} />}
                    hint={group.type}
                    onSelect={() => go(path(`groups/${group.id}`))}
                  >
                    {group.name}
                  </Item>
                ))}
              </CommandGroup>
            )}

            {sources?.length || pools?.length ? (
              <CommandGroup className="px-1.5">
                <CommandGroupLabel className={groupHeadingClass}>节点来源</CommandGroupLabel>
                {sources?.map((source) => (
                  <Item
                    key={source.id}
                    value={`source-${source.id}`}
                    label={source.display_name || source.name}
                    keywords={['source', source.name]}
                    icon={<RadioTower size={13} />}
                    hint={source.kind === 'local' ? '本地' : '订阅'}
                    onSelect={() => go(`/sources/${source.id}`)}
                  >
                    {source.display_name || source.name}
                  </Item>
                ))}
                {pools?.map((pool) => (
                  <Item
                    key={pool.id}
                    value={`pool-${pool.id}`}
                    label={pool.name}
                    keywords={['pool', pool.slug ?? '']}
                    icon={<Layers size={13} />}
                    hint="聚合"
                    onSelect={() => go(`/pools/${pool.id}`)}
                  >
                    {pool.name}
                  </Item>
                ))}
              </CommandGroup>
            ) : null}

            {sources?.length || pools?.length ? (
              <CommandGroup className="px-1.5">
                <CommandGroupLabel className={groupHeadingClass}>智能命名</CommandGroupLabel>
                {sources?.map((source) => {
                  const command = namingCommand(source.display_name || source.name, ['source', source.id, source.name]);
                  return (
                    <Item
                      key={`naming-source-${source.id}`}
                      value={command.value}
                      label={command.label}
                      keywords={['智能命名', 'naming', source.name]}
                      icon={<Sparkles size={13} />}
                      hint="订阅源"
                      onSelect={() => go(`/sources/${source.id}/naming`)}
                    >
                      {command.label}
                    </Item>
                  );
                })}
                {pools?.map((pool) => {
                  const command = namingCommand(pool.name, ['pool', pool.id, pool.slug ?? '']);
                  return (
                    <Item
                      key={`naming-pool-${pool.id}`}
                      value={command.value}
                      label={command.label}
                      keywords={['智能命名', 'naming', pool.name, pool.slug ?? '']}
                      icon={<Sparkles size={13} />}
                      hint="聚合订阅"
                      onSelect={() => go(`/pools/${pool.id}/naming`)}
                    >
                      {command.label}
                    </Item>
                  );
                })}
              </CommandGroup>
            ) : null}

            {devices && devices.length > 0 && (
              <CommandGroup className="px-1.5">
                <CommandGroupLabel className={groupHeadingClass}>设备</CommandGroupLabel>
                {devices.map((device) => (
                  <Item
                    key={device.id}
                    value={`device-${device.id}`}
                    label={device.display_name || device.name}
                    keywords={['device', device.name]}
                    icon={<MonitorSmartphone size={13} />}
                    onSelect={() => go(path(`devices/${device.id}`))}
                  >
                    {device.display_name || device.name}
                  </Item>
                ))}
              </CommandGroup>
            )}

            {ruleSets && ruleSets.length > 0 && (
              <CommandGroup className="px-1.5">
                <CommandGroupLabel className={groupHeadingClass}>规则集</CommandGroupLabel>
                {ruleSets.map((set) => (
                  <Item
                    key={set.id}
                    value={`ruleset-${set.id}`}
                    label={set.name}
                    keywords={['ruleset']}
                    icon={<BookMarked size={13} />}
                    hint={set.source === 'remote' ? '远程' : '本地'}
                    onSelect={() => go(`/rule-sets?open=${set.id}`)}
                  >
                    {set.name}
                  </Item>
                ))}
              </CommandGroup>
            )}

            {profiles && profiles.length > 1 && (
              <CommandGroup className="px-1.5">
                <CommandGroupLabel className={groupHeadingClass}>切换配置文件</CommandGroupLabel>
                {profiles.map((p) => (
                  <Item
                    key={p.id}
                    value={`profile-${p.id}`}
                    label={profileTitle(p)}
                    keywords={['profile', p.name]}
                    icon={<Waypoints size={13} />}
                    hint={p.kind === 'template' ? '模版' : p.name}
                    onSelect={() => go(profilePath(p.name))}
                  >
                    {profileTitle(p)}
                  </Item>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <div className="flex items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-3">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 选择
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> 执行
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              跳转快捷键 <Kbd>G</Kbd> <ArrowRight size={10} /> <Kbd>R</Kbd> 规则
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
