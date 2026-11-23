'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
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
import { cn } from '@/ui/lib/cn';
import { copyText, Kbd, notify } from '@/ui/primitives';
import { useLineColors, LineDot } from '@/ui/viz/lines';
import { ALL_NAV } from './nav';
import { profilePath, useActiveProfile } from './scope';
import { openAssistant, openShare, setUi, useUi } from './state';
import { profileTitle } from './profile-switcher';

const groupClass =
  'px-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3';

function Item({
  icon,
  children,
  hint,
  onSelect,
  value,
  keywords,
  forceMount,
}: {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  value: string;
  keywords?: string[];
  /** Always show, regardless of the search query. */
  forceMount?: boolean;
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      forceMount={forceMount}
      onSelect={onSelect}
      className="group flex h-10 cursor-default items-center gap-3 rounded-lg px-2.5 text-sm text-ink data-[selected=true]:bg-surface-2"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink-2 group-data-[selected=true]:border-line-strong">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-ink-3">{hint}</span>}
      <CornerDownLeft size={13} className="shrink-0 text-ink-4 opacity-0 group-data-[selected=true]:opacity-100" />
    </Command.Item>
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
    close();
    router.push(href);
  };
  const path = (sub?: string) => (profile ? profilePath(profile.name, sub) : '/');

  const sortedGroups = useMemo(() => (groups ?? []).slice().sort((a, b) => a.rank - b.rank), [groups]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => (next ? setUi({ paletteOpen: true }) : close())}
      label="命令面板"
      loop
      overlayClassName="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in"
      contentClassName={cn(
        'fixed left-1/2 top-[12vh] z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-xl',
        'data-[state=open]:animate-pop',
      )}
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search size={17} className="shrink-0 text-ink-3" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="跳转页面、搜索策略组 / 订阅源 / 设备，或执行操作…"
          className="h-14 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[min(460px,60vh)] overflow-y-auto pb-2 scroll-fade-y">
        <Command.Empty className="flex flex-col items-center gap-2 py-12 text-sm text-ink-3">
          <Search size={20} className="text-ink-4" />
          没有找到「{search}」
        </Command.Empty>

        {search.trim().length > 0 && profile && (
          <Command.Group heading="在规则中搜索" className={groupClass}>
            <Item
              value={`search-rules ${search}`}
              icon={<Search size={13} />}
              onSelect={() => go(`${path('rules')}?q=${encodeURIComponent(search.trim())}`)}
            >
              搜索规则：<span className="font-mono text-[13px]">{search.trim()}</span>
            </Item>
          </Command.Group>
        )}

        <Command.Group heading="操作" className={groupClass}>
          <Item value="new rule 新建规则 添加规则" icon={<ListPlus size={13} />} hint="规则" onSelect={() => go(`${path('rules')}?compose=1`)}>
            新建规则
          </Item>
          <Item value="new group 新建策略组" icon={<Plus size={13} />} hint="策略组" onSelect={() => go(`${path('groups')}?new=1`)}>
            新建策略组
          </Item>
          <Item value="add source 添加订阅源" icon={<RadioTower size={13} />} hint="节点来源" onSelect={() => go('/sources?new=1')}>
            添加订阅源
          </Item>
          {dashboard?.meta.subscriptionUrl && (
            <Item
              value="copy subscription link 复制订阅链接"
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
          <Item value="share qr 二维码 分享 订阅" icon={<QrCode size={13} />} onSelect={() => { close(); openShare(); }}>
            订阅链接与二维码
          </Item>
          <Item
            value="ai assistant 助手 ai"
            forceMount={search.trim().length > 0}
            icon={<Sparkles size={13} className="text-accent" />}
            hint="⌘J"
            onSelect={() => {
              close();
              openAssistant(search.trim() || undefined);
            }}
          >
            {search.trim() ? <>问 AI：{search.trim()}</> : '打开 AI 助手'}
          </Item>
          <Item
            value="toggle theme 切换主题 深色 浅色"
            icon={resolvedTheme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            onSelect={() => {
              close();
              setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
            }}
          >
            切换到{resolvedTheme === 'dark' ? '浅色' : '深色'}主题
          </Item>
        </Command.Group>

        <Command.Group heading="跳转" className={groupClass}>
          {ALL_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Item
                key={item.id}
                value={`nav ${item.label} ${item.id}`}
                keywords={[item.hint ?? '']}
                icon={<Icon size={13} />}
                hint={item.hint}
                onSelect={() => go(item.scoped ? path(item.href || undefined) : item.href)}
              >
                {item.label}
              </Item>
            );
          })}
        </Command.Group>

        {sortedGroups.length > 0 && (
          <Command.Group heading="策略组" className={groupClass}>
            {sortedGroups.map((group) => (
              <Item
                key={group.id}
                value={`group ${group.name}`}
                icon={<LineDot color={color(group.name)} size={9} />}
                hint={group.type}
                onSelect={() => go(path(`groups/${group.id}`))}
              >
                {group.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {(sources?.length || pools?.length) ? (
          <Command.Group heading="节点来源" className={groupClass}>
            {sources?.map((source) => (
              <Item
                key={source.id}
                value={`source ${source.name} ${source.display_name ?? ''}`}
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
                value={`pool ${pool.name} ${pool.slug ?? ''}`}
                icon={<Layers size={13} />}
                hint="聚合"
                onSelect={() => go(`/pools/${pool.id}`)}
              >
                {pool.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {(sources?.length || pools?.length) ? (
          <Command.Group heading="智能命名" className={groupClass}>
            {sources?.map((source) => (
              <Item
                key={`naming-source-${source.id}`}
                value={`naming source ${source.id} ${source.name} ${source.display_name ?? ''} 智能命名`}
                icon={<Sparkles size={13} />}
                hint="订阅源"
                onSelect={() => go(`/sources/${source.id}/naming`)}
              >
                智能命名 · {source.display_name || source.name}
              </Item>
            ))}
            {pools?.map((pool) => (
              <Item
                key={`naming-pool-${pool.id}`}
                value={`naming pool ${pool.id} ${pool.name} ${pool.slug ?? ''} 智能命名`}
                icon={<Sparkles size={13} />}
                hint="聚合订阅"
                onSelect={() => go(`/pools/${pool.id}/naming`)}
              >
                智能命名 · {pool.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {devices && devices.length > 0 && (
          <Command.Group heading="设备" className={groupClass}>
            {devices.map((device) => (
              <Item
                key={device.id}
                value={`device ${device.name} ${device.display_name ?? ''}`}
                icon={<MonitorSmartphone size={13} />}
                onSelect={() => go(path(`devices/${device.id}`))}
              >
                {device.display_name || device.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {ruleSets && ruleSets.length > 0 && (
          <Command.Group heading="规则集" className={groupClass}>
            {ruleSets.map((set) => (
              <Item key={set.id} value={`ruleset ${set.name}`} icon={<BookMarked size={13} />} hint={set.source === 'remote' ? '远程' : '本地'} onSelect={() => go(`/rule-sets?open=${set.id}`)}>
                {set.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {profiles && profiles.length > 1 && (
          <Command.Group heading="切换配置文件" className={groupClass}>
            {profiles.map((p) => (
              <Item
                key={p.id}
                value={`profile ${p.name} ${p.display_name ?? ''}`}
                icon={<Waypoints size={13} />}
                hint={p.kind === 'template' ? '模版' : p.name}
                onSelect={() => go(profilePath(p.name))}
              >
                {profileTitle(p)}
              </Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <div className="flex items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> 选择</span>
        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> 执行</span>
        <span className="ml-auto flex items-center gap-1.5">
          跳转快捷键 <Kbd>G</Kbd> <ArrowRight size={10} /> <Kbd>R</Kbd> 规则
        </span>
      </div>
    </Command.Dialog>
  );
}
