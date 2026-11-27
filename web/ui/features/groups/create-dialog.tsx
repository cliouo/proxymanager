'use client';

import { useMemo, useState } from 'react';
import { Radio, RadioGroup } from '@ui-sdk/react/radio';
import { CornerDownRight, Gauge, Link2, ShieldCheck, Shuffle } from 'lucide-react';
import type { ProxyGroupType } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Button, Combobox, Dialog, Field, Input, notify, Select } from '@/ui/primitives';
import { isBuiltinPolicy } from '@/ui/viz/lines';
import { useWorkspace } from './context';
import { afterGroupWrite, groupApi, putGroupLocally } from './data';
import { MatchPreview, PickList, RegionQuickFill, useMemberOptions } from './members';
import {
  autoMembers,
  createBody,
  DEFAULT_TEST_URL,
  isHealthType,
  sourceLabel,
  uniqueName,
  type Draft,
  type MemberMode,
} from './model';

type PresetId = 'region' | 'select' | 'fallback' | 'load-balance' | 'bound';

const PRESETS: Array<{
  id: PresetId;
  icon: typeof Gauge;
  title: string;
  body: string;
  type: ProxyGroupType;
  mode: MemberMode;
  name: string;
}> = [
  { id: 'region', icon: Gauge, title: '地区测速组', body: '按名字筛出一个地区，自动选最快的', type: 'url-test', mode: 'auto', name: '地区节点' },
  { id: 'select', icon: CornerDownRight, title: '手动选择组', body: '在客户端里手动切换出口', type: 'select', mode: 'manual', name: '手动选择' },
  { id: 'fallback', icon: ShieldCheck, title: '故障转移组', body: '按顺序用第一个可用的成员', type: 'fallback', mode: 'manual', name: '故障转移' },
  { id: 'load-balance', icon: Shuffle, title: '负载均衡组', body: '把连接分散到多个成员上', type: 'load-balance', mode: 'manual', name: '负载均衡' },
  { id: 'bound', icon: Link2, title: '绑定订阅源', body: '直接使用一个订阅源的全部节点', type: 'select', mode: 'bound', name: '订阅源节点' },
];

const BLANK: Omit<Draft, 'name' | 'type' | 'mode'> = {
  hidden: false,
  proxies: [],
  includeAll: false,
  filter: '',
  excludeFilter: '',
  excludeType: [],
  boundSubscriptionId: '',
  url: '',
  interval: '',
  tolerance: '',
  timeout: '',
  lazy: undefined,
  expectedStatus: '',
  maxFailedTimes: '',
  strategy: '',
  templateId: '',
  emptyFallback: '',
  dialerProxy: '',
  disableUdp: undefined,
  icon: '',
  routingMark: '',
  section: '',
  notes: '',
};

export function CreateGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const [wasOpen, setWasOpen] = useState(open);
  const [preset, setPreset] = useState<PresetId>('region');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [filter, setFilter] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [subId, setSubId] = useState('');
  const [section, setSection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { options, kindOf } = useMemberOptions(null);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPreset('region');
      setName('');
      setNameTouched(false);
      setFilter('');
      setMembers([]);
      setSubId('');
      setSection(null);
    }
  }

  const spec = PRESETS.find((p) => p.id === preset)!;
  const taken = useMemo(() => new Set(ws.groups.map((g) => g.name)), [ws.groups]);
  const sections = useMemo(
    () => [...new Set(ws.groups.map((g) => g.section?.trim()).filter((s): s is string => !!s))],
    [ws.groups],
  );
  const defaultSection = preset === 'region' && sections.includes('地区') ? '地区' : '';
  const sectionValue = section ?? defaultSection;
  const auto = useMemo(
    () => autoMembers(ws.catalog.names ?? [], filter, '', [], ws.catalog.types),
    [ws.catalog.names, ws.catalog.types, filter],
  );

  const suggest = (base: string) => {
    if (!nameTouched) setName(uniqueName(base, taken));
  };
  const pickPreset = (id: PresetId) => {
    setPreset(id);
    const next = PRESETS.find((p) => p.id === id)!;
    if (!nameTouched) setName('');
    if (id !== 'region' && id !== 'bound') suggest(next.name);
  };

  const trimmed = name.trim();
  const nameError = !trimmed
    ? null
    : taken.has(trimmed)
      ? '已经有同名的策略组'
      : isBuiltinPolicy(trimmed)
        ? `${trimmed} 是内置策略，不能用作名字`
        : null;
  const memberError =
    spec.mode === 'auto'
      ? !filter.trim()
        ? '选一个地区，或写一个筛选正则'
        : auto.error
      : spec.mode === 'bound'
        ? !subId
          ? '选择要绑定的订阅源'
          : null
        : members.length === 0
          ? '至少添加一个成员'
          : null;
  const canCreate = !!trimmed && !nameError && !memberError && !busy;

  const create = async () => {
    if (!canCreate) return;
    const health = isHealthType(spec.type);
    const draft: Draft = {
      ...BLANK,
      name: trimmed,
      type: spec.type,
      mode: spec.mode,
      proxies: spec.mode === 'manual' ? members : [],
      includeAll: spec.mode === 'auto',
      filter: spec.mode === 'auto' ? filter.trim() : '',
      boundSubscriptionId: spec.mode === 'bound' ? subId : '',
      url: health ? DEFAULT_TEST_URL : '',
      interval: health ? '300' : '',
      tolerance: spec.type === 'url-test' ? '50' : '',
      strategy: spec.type === 'load-balance' ? 'consistent-hashing' : '',
      section: sectionValue,
    };
    setBusy(true);
    try {
      const created = await groupApi.create(ws.profileId, createBody(draft));
      putGroupLocally(ws.profileId, created);
      afterGroupWrite(ws.profileId);
      notify.success(`已创建「${created.name}」`);
      onOpenChange(false);
      await ws.select(created.id, { force: true });
    } catch (error) {
      notify.error(error, '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const sources = ws.catalog.sources ?? [];
  const subOptions = sources.map((sub) => {
    const inProfile = !ws.catalog.profileSubIds || ws.catalog.profileSubIds.has(sub.id);
    const count = ws.catalog.bySub?.[sub.name]?.length;
    return {
      value: sub.id,
      label: sourceLabel(sub),
      description: !sub.enabled ? '已停用' : !inProfile ? '这份配置没有用到它' : count !== undefined ? `${count} 个节点` : undefined,
      disabled: !sub.enabled || !inProfile,
    };
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="新建策略组"
      description="选一个起点，创建后可以在右侧继续细调。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!canCreate}
            data-agent-confirm={`创建策略组「${trimmed || '新策略组'}」`}
            onClick={() => void create()}
          >
            创建
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[208px_minmax(0,1fr)]">
        <RadioGroup
          aria-label="策略组起点"
          value={preset}
          onValueChange={(next) => {
            if (next) pickPreset(next as PresetId);
          }}
          className="flex flex-col gap-1"
        >
          {PRESETS.map((p) => {
            const active = p.id === preset;
            const Icon = p.icon;
            return (
              <Radio
                key={p.id}
                value={p.id}
                aria-label={p.title}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  active ? 'border-accent-line bg-accent-soft/60' : 'border-transparent hover:bg-surface-2',
                )}
              >
                <span
                  className={cn(
                    'mt-px flex size-6 shrink-0 items-center justify-center rounded-md',
                    active ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-3',
                  )}
                >
                  <Icon size={13} strokeWidth={1.9} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">{p.title}</span>
                  <span className="block text-[11px] leading-snug text-ink-3">{p.body}</span>
                </span>
              </Radio>
            );
          })}
        </RadioGroup>

        <div className="flex min-w-0 flex-col gap-4">
          <Field label="名字" error={nameError} hint="会显示在客户端的策略组列表里。">
            {(id) => (
              <Input
                id={id}
                data-autofocus
                value={name}
                invalid={!!nameError}
                placeholder={spec.mode === 'auto' ? '例如 香港节点' : `例如 ${spec.name}`}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) void create();
                }}
              />
            )}
          </Field>

          {spec.mode === 'auto' && (
            <Field label="地区或正则" error={filter.trim() ? auto.error : undefined}>
              {(id) => (
                <div className="flex flex-col gap-2">
                  <RegionQuickFill
                    onPick={(region) => {
                      setFilter(region.pattern);
                      suggest(region.name);
                    }}
                  />
                  <Input
                    id={id}
                    mono
                    value={filter}
                    invalid={!!(filter.trim() && auto.error)}
                    placeholder="(?i)港|HK|Hong Kong"
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  {filter.trim() && <MatchPreview auto={auto} filter={filter} />}
                </div>
              )}
            </Field>
          )}

          {spec.mode === 'manual' && (
            <Field label={spec.type === 'fallback' ? '成员（按顺序尝试）' : '成员'}>
              {() => (
                <PickList
                  value={members}
                  onChange={setMembers}
                  type={spec.type}
                  options={options}
                  kindOf={kindOf}
                  emptyHint="添加节点、其他策略组，或直连 DIRECT。"
                />
              )}
            </Field>
          )}

          {spec.mode === 'bound' && (
            <Field label="订阅源" hint="成员会随订阅更新自动变化。">
              {(id) => (
                <Select
                  id={id}
                  value={subId || undefined}
                  onValueChange={(value) => {
                    setSubId(value);
                    const sub = sources.find((s) => s.id === value);
                    if (sub) suggest(sourceLabel(sub));
                  }}
                  options={subOptions}
                  placeholder="选择订阅源"
                />
              )}
            </Field>
          )}

          <Field label="分组" optional hint="只用于左侧列表归类。">
            {(id) => (
              <Combobox
                id={id}
                value={sectionValue || null}
                onChange={(value) => setSection(value === '__none__' ? '' : value)}
                options={[{ value: '__none__', label: '不分组' }, ...sections.map((s) => ({ value: s, label: s }))]}
                allowCustom
                customLabel={(query) => <>新建分组「{query}」</>}
                placeholder="不分组"
                searchPlaceholder="输入或选择分组…"
              />
            )}
          </Field>

          {memberError && trimmed && !(spec.mode === 'auto' && filter.trim()) && (
            <p data-validation-hint className="text-xs text-ink-3">{memberError}</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
