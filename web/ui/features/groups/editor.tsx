'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { Input as UiInput } from '@ui-sdk/react/input';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Copy,
  CornerDownRight,
  EyeOff,
  Link2,
  ListTree,
  MoreHorizontal,
  Trash2,
  Waypoints,
} from 'lucide-react';
import type { ProxyGroup } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { relativeTime } from '@/ui/lib/format';
import {
  Button,
  Combobox,
  confirmAction,
  EmptyState,
  Field,
  Input,
  Menu,
  notify,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Textarea,
  Tooltip,
  type ComboOption,
} from '@/ui/primitives';
import { SaveBar } from '@/ui/shell/page';
import { useHotkey } from '@/ui/shell/hotkeys';
import { GROUP_TYPES, groupTypeMeta, LineDot, PolicyChip, useLineColors } from '@/ui/viz/lines';
import { describeNode, Flag } from '@/ui/viz/nodes';
import { Note, Section } from './bits';
import { useWorkspace } from './context';
import { afterGroupWrite, groupApi, putGroupLocally } from './data';
import { registerDirtyCheck } from './guard';
import { MembersComposer } from './members';
import {
  autoMembers,
  buildPatch,
  createBody,
  DEFAULT_TEST_URL,
  GROUP_TYPE_ORDER,
  inheritedFields,
  isHealthType,
  LB_STRATEGIES,
  sameDraft,
  TEMPLATE_FIELD_LABELS,
  templateFieldText,
  toDraft,
  uniqueName,
  validateDraft,
  type Draft,
} from './model';

const NONE = '__none__';

export function GroupEditorPane() {
  const ws = useWorkspace();
  const params = useParams<{ id?: string }>();
  const id = params?.id ? decodeURIComponent(params.id) : null;
  const group = ws.groups.find((g) => g.id === id);

  if (!ws.book.data) {
    if (ws.book.error) {
      return (
        <EmptyState
          icon={Waypoints}
          title="策略组没有加载出来"
          description="网络或服务出了点问题。"
          actions={<Button onClick={() => void ws.book.refetch()}>重试</Button>}
        />
      );
    }
    return <EditorSkeleton />;
  }
  if (!group) {
    return (
      <EmptyState
        className="pt-16"
        icon={Waypoints}
        title="找不到这个策略组"
        description="它可能已被删除或改到了别的配置文件。"
        actions={
          <Button asChild variant="secondary">
            <Link href={ws.hrefFor(null)}>回到线路总览</Link>
          </Button>
        }
      />
    );
  }
  return <GroupEditor key={group.id} group={group} />;
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <div className="flex items-center gap-3">
        <Skeleton className="size-3 rounded-full" />
        <Skeleton className="h-7 w-48" />
      </div>
      <Skeleton className="h-4 w-72" />
      {[120, 260, 160].map((h, i) => (
        <Skeleton key={i} className="w-full rounded-xl" style={{ height: h }} />
      ))}
    </div>
  );
}

function GroupEditor({ group }: { group: ProxyGroup }) {
  const ws = useWorkspace();
  const router = useRouter();
  const { color } = useLineColors();
  const [draft, setDraft] = useState<Draft>(() => toDraft(group));
  const [seen, setSeen] = useState(group);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // A fresh server copy replaces the form unless the user is mid-edit.
  if (seen !== group) {
    setSeen(group);
    if (sameDraft(draft, toDraft(seen))) setDraft(toDraft(group));
  }

  const initial = useMemo(() => toDraft(group), [group]);
  const dirty = !sameDraft(draft, initial);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  useEffect(() => registerDirtyCheck(() => dirty), [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const { groups, catalog, ruleCounts, templates, profileId } = ws;
  const auto = useMemo(
    () => autoMembers(catalog.names ?? [], draft.filter, draft.excludeFilter, draft.excludeType, catalog.types),
    [catalog.names, catalog.types, draft.filter, draft.excludeFilter, draft.excludeType],
  );
  const otherNames = useMemo(() => new Set(groups.filter((g) => g.id !== group.id).map((g) => g.name)), [groups, group.id]);
  const errors = validateDraft(draft, {
    original: group,
    otherNames,
    regexError: auto.error,
    excludeError: auto.excludeError,
  });
  const errorCount = Object.keys(errors).length;

  const ruleCount = ruleCounts[group.name] ?? 0;
  const parents = groups.filter((g) => g.id !== group.id && (g.proxies ?? []).includes(group.name));
  const dialerUsers = groups.filter((g) => g['dialer-proxy'] === group.name);
  const template = templates?.find((t) => t.id === draft.templateId);
  const isFrontPool = ws.frontPools.has(group.name);
  const renaming = draft.name.trim() !== group.name && !errors.name;
  const rulesHref = `${ws.path('rules')}?policy=${encodeURIComponent(group.name)}`;
  const position = groups.findIndex((g) => g.id === group.id) + 1;

  const save = async () => {
    if (!dirty || saving) return;
    if (errorCount > 0) {
      notify.warn('还有需要修正的地方', Object.values(errors)[0]);
      return;
    }
    const patch = buildPatch(group, draft);
    if (Object.keys(patch).length === 0) {
      setDraft(initial);
      return;
    }
    setSaving(true);
    try {
      const updated = await groupApi.patch(profileId, group.id, patch);
      putGroupLocally(profileId, updated);
      setSeen(updated);
      setDraft(toDraft(updated));
      afterGroupWrite(profileId);
      const cascaded = patch.name !== undefined ? ruleCount + parents.length + dialerUsers.length : 0;
      notify.success('已保存', cascaded > 0 ? `引用它的 ${cascaded} 处已同步改成新名字` : undefined);
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  useHotkey('mod+s', () => void save(), { enabled: dirty });

  const duplicate = async () => {
    const taken = new Set(groups.map((g) => g.name));
    const name = uniqueName(`${group.name} 副本`, taken);
    const rankFree = !groups.some((g) => g.rank === group.rank + 1);
    try {
      const created = await groupApi.create(profileId, {
        ...createBody({ ...toDraft(group), name }),
        ...(rankFree ? { rank: group.rank + 1 } : {}),
      });
      putGroupLocally(profileId, created);
      afterGroupWrite(profileId);
      notify.success(`已复制为「${name}」`);
      await ws.select(created.id);
    } catch (error) {
      notify.error(error, '复制失败');
    }
  };

  const remove = async () => {
    const refs = [
      ruleCount ? `${ruleCount} 条规则` : null,
      parents.length ? `策略组 ${parents.map((g) => `「${g.name}」`).join('')}` : null,
      dialerUsers.length ? `链式代理 ${dialerUsers.map((g) => `「${g.name}」`).join('')}` : null,
    ].filter(Boolean);
    if (refs.length > 0) {
      const go = await confirmAction({
        title: `还不能删除「${group.name}」`,
        description: `它仍被 ${refs.join('、')} 引用。先把这些引用改到别的策略组，再回来删除。`,
        confirmText: ruleCount ? '查看引用它的规则' : '知道了',
      });
      if (go && ruleCount) router.push(rulesHref);
      return;
    }
    const ok = await confirmAction({
      title: `删除「${group.name}」？`,
      description: '没有规则或策略组用到它。删除后客户端里不再有这条线路。',
      confirmText: '确认删除',
      confirmHint: `删除策略组「${group.name}」`,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await groupApi.remove(profileId, group.id);
      notify.success(`已删除「${group.name}」`);
      await ws.select(null, { force: true });
      afterGroupWrite(profileId);
    } catch (error) {
      notify.error(error, '删除失败');
    }
  };

  const typeMeta = groupTypeMeta(draft.type);
  const health = isHealthType(draft.type);

  return (
    <div className="flex animate-rise flex-col gap-5">
      <Link
        href={ws.hrefFor(null)}
        className="inline-flex items-center gap-1 text-xs font-medium text-ink-3 transition hover:text-ink @3xl/main:hidden"
      >
        <ArrowLeft size={13} />
        全部策略组
      </Link>

      {/* header */}
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <LineDot color={color(group.name)} size={12} className="mt-[13px]" />
          <div className="min-w-0 flex-1">
            <UiInput
              value={draft.name}
              onValueChange={(name) => set({ name })}
              aria-label="策略组名字"
              aria-invalid={!!errors.name || undefined}
              spellCheck={false}
              className={cn(
                '-mx-1.5 w-[calc(100%+12px)] rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-ink outline-none transition-[border-color,box-shadow,background-color]',
                'hover:border-line focus:border-accent focus:bg-surface focus:shadow-[var(--ring)]',
                errors.name && 'border-bad',
              )}
            />
            {errors.name ? (
              <p className="mt-1 text-xs text-bad">{errors.name}</p>
            ) : renaming ? (
              <p className="mt-1 text-xs text-accent">
                改名会同步更新引用它的规则
                {parents.length + dialerUsers.length > 0 ? '和策略组' : ''}
                {ruleCount + parents.length + dialerUsers.length > 0 ? `（共 ${ruleCount + parents.length + dialerUsers.length} 处）` : ''}。
              </p>
            ) : (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                <span>第 {position} 条线路</span>
                {group.section && (
                  <>
                    <span className="text-ink-4">·</span>
                    <span>{group.section}</span>
                  </>
                )}
                <span className="text-ink-4">·</span>
                <span>{relativeTime(group.updated_at)}更新</span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1.5">
            <Tooltip content="在客户端的策略组列表里隐藏它，规则照常生效">
              <label className="flex items-center gap-1.5 text-xs text-ink-2">
                <EyeOff size={13} className="text-ink-3" />
                隐藏
                <Switch size="sm" checked={draft.hidden} onCheckedChange={(hidden) => set({ hidden })} label="在客户端隐藏" />
              </label>
            </Tooltip>
            <Menu
              trigger={<Button iconOnly variant="ghost" icon={MoreHorizontal} aria-label="策略组更多操作" />}
              items={[
                {
                  label: '复制为新组',
                  icon: Copy,
                  confirm: `复制策略组「${group.name}」`,
                  onSelect: () => void duplicate(),
                },
                { label: '查看引用它的规则', icon: ListTree, onSelect: () => router.push(rulesHref), disabled: !ruleCount },
                'separator',
                { label: '删除', icon: Trash2, tone: 'danger', onSelect: () => void remove() },
              ]}
            />
          </div>
        </div>

        {/* usage strip */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-ink-2">
          {ruleCount > 0 ? (
            <Link href={rulesHref} className="inline-flex items-center gap-1.5 font-medium hover:text-ink">
              <ListTree size={13} className="text-ink-3" />
              <span className="tnum">{ruleCount}</span> 条规则把流量送到这里
              <ArrowUpRight size={12} className="text-ink-4" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-ink-3">
              <ListTree size={13} />
              还没有规则直接用它
            </span>
          )}
          {parents.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <CornerDownRight size={13} className="text-ink-3" />
              被
              {parents.map((g) => (
                <UiButton key={g.id} type="button" onClick={() => void ws.select(g.id)} className="rounded-full transition hover:opacity-80">
                  <PolicyChip policy={g.name} size="sm" />
                </UiButton>
              ))}
              引用
            </span>
          )}
          {dialerUsers.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Link2 size={13} className="text-ink-3" />
              是 {dialerUsers.map((g) => `「${g.name}」`).join('')} 的前置
            </span>
          )}
        </div>
      </header>

      {isFrontPool && (
        <Note tone="info" icon={Link2} title="链式代理的前置池">
          其他策略组通过它出站。它不会出现在规则和成员的候选里，修改成员会影响链路的前一跳。
        </Note>
      )}

      {/* type */}
      <Section title="类型" description="决定这条线路怎么在成员之间选出口。">
        <div className="flex flex-col gap-2.5">
          <div className="overflow-x-auto">
            <SegmentedControl
              label="策略组类型"
              value={draft.type}
              onChange={(type) => set({ type })}
              options={GROUP_TYPE_ORDER.map((type) => ({
                value: type,
                label: GROUP_TYPES[type].label,
                icon: GROUP_TYPES[type].icon,
              }))}
            />
          </div>
          <p className="text-xs text-ink-2">{typeMeta.description}。</p>
        </div>
      </Section>

      {/* members */}
      <Section title="成员" description="成员从哪里来？三种方式任选其一。">
        <MembersComposer
          group={group}
          draft={draft}
          set={set}
          errors={errors}
          auto={auto}
          brokenReason={ws.brokenBindings.get(group.id)}
        />
      </Section>

      {/* health check */}
      {health && (
        <Section
          title="健康检查"
          description={
            template
              ? `留空的项沿用模版「${template.name}」，模版也没写的用默认值。`
              : '定时探测成员是否可用；留空的项使用默认值。'
          }
        >
          <HealthFields draft={draft} set={set} errors={errors} template={template} />
        </Section>
      )}

      {/* advanced */}
      <Collapsible
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        className="rounded-xl border border-line bg-surface shadow-xs"
      >
        <CollapsibleTrigger
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-left transition-colors hover:bg-surface-2/50"
        >
          <span>
            <span className="block text-sm font-semibold tracking-tight text-ink">高级设置</span>
            <span className="mt-0.5 block text-xs text-ink-3">模版、空成员兜底、前置代理、分组与备注</span>
          </span>
          <ChevronDown size={16} className={cn('shrink-0 text-ink-3 transition-transform', advancedOpen && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsiblePanel className="animate-fade-in border-t border-line px-4 pb-4 pt-3">
          <AdvancedFields draft={draft} set={set} errors={errors} groupName={group.name} />
        </CollapsiblePanel>
      </Collapsible>

      <SaveBar
        visible={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => setDraft(initial)}
        message={errorCount > 0 ? `有 ${errorCount} 处需要修正` : '有未保存的修改'}
      />
    </div>
  );
}

/* ─── health check ───────────────────────────────────────────────────── */

function NumberInput({
  id,
  value,
  onChange,
  placeholder,
  unit,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  unit?: string;
  invalid?: boolean;
}) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      value={value}
      invalid={invalid}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value.replace(/[^\d-]/g, ''))}
      className="tnum"
      trailing={unit ? <span className="pr-1 text-xs text-ink-3">{unit}</span> : undefined}
    />
  );
}

function HealthFields({
  draft,
  set,
  errors,
  template,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  errors: ReturnType<typeof validateDraft>;
  template: { url?: string; interval?: number; tolerance?: number; timeout?: number; lazy?: boolean; 'expected-status'?: string; 'max-failed-times'?: number; strategy?: string } | undefined;
}) {
  const lazy = draft.lazy ?? template?.lazy ?? true;
  return (
    <div className="flex flex-col gap-3">
      <Field label="测速地址" error={errors.url}>
        {(id) => (
          <Input
            id={id}
            mono
            value={draft.url}
            invalid={!!errors.url}
            placeholder={template?.url ?? DEFAULT_TEST_URL}
            onChange={(event) => set({ url: event.target.value })}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="测速间隔" error={errors.interval}>
          {(id) => (
            <NumberInput
              id={id}
              value={draft.interval}
              onChange={(interval) => set({ interval })}
              placeholder={String(template?.interval ?? 300)}
              unit="秒"
              invalid={!!errors.interval}
            />
          )}
        </Field>
        {draft.type === 'url-test' && (
          <Field label="切换容差" error={errors.tolerance} hint="快过当前节点这么多才切换">
            {(id) => (
              <NumberInput
                id={id}
                value={draft.tolerance}
                onChange={(tolerance) => set({ tolerance })}
                placeholder={String(template?.tolerance ?? 0)}
                unit="毫秒"
                invalid={!!errors.tolerance}
              />
            )}
          </Field>
        )}
        <Field label="超时" error={errors.timeout}>
          {(id) => (
            <NumberInput
              id={id}
              value={draft.timeout}
              onChange={(timeout) => set({ timeout })}
              placeholder={String(template?.timeout ?? 5000)}
              unit="毫秒"
              invalid={!!errors.timeout}
            />
          )}
        </Field>
        <Field label="失败几次算不可用" error={errors.maxFailedTimes}>
          {(id) => (
            <NumberInput
              id={id}
              value={draft.maxFailedTimes}
              onChange={(maxFailedTimes) => set({ maxFailedTimes })}
              placeholder={String(template?.['max-failed-times'] ?? 5)}
              unit="次"
              invalid={!!errors.maxFailedTimes}
            />
          )}
        </Field>
        <Field label="期望状态码" error={errors.expectedStatus}>
          {(id) => (
            <Input
              id={id}
              mono
              value={draft.expectedStatus}
              invalid={!!errors.expectedStatus}
              placeholder={template?.['expected-status'] ?? '不限，例如 204'}
              onChange={(event) => set({ expectedStatus: event.target.value })}
            />
          )}
        </Field>
      </div>
      <Field inline label="懒测速" hint="只有这条线路真正被用到时才开始测速，省流量。" className="border-t border-line pb-0 pt-3">
        {(id) => <Switch id={id} checked={lazy} onCheckedChange={(value) => set({ lazy: value })} />}
      </Field>
      {draft.type === 'load-balance' && (
        <Field label="分配策略" hint={LB_STRATEGIES.find((s) => s.value === (draft.strategy || template?.strategy || 'consistent-hashing'))?.description}>
          {(id) => (
            <Select
              id={id}
              value={draft.strategy || undefined}
              onValueChange={(strategy) => set({ strategy })}
              placeholder={`默认（${LB_STRATEGIES.find((s) => s.value === (template?.strategy ?? 'consistent-hashing'))?.label ?? '一致性哈希'}）`}
              options={LB_STRATEGIES.map((s) => ({ value: s.value, label: s.label, description: s.value }))}
            />
          )}
        </Field>
      )}
    </div>
  );
}

/* ─── advanced ───────────────────────────────────────────────────────── */

function AdvancedFields({
  draft,
  set,
  errors,
  groupName,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  errors: ReturnType<typeof validateDraft>;
  groupName: string;
}) {
  const ws = useWorkspace();
  const { color } = useLineColors();
  const template = ws.templates?.find((t) => t.id === draft.templateId);
  const inherited = inheritedFields(template, draft);
  const sections = [...new Set(ws.groups.map((g) => g.section?.trim()).filter((s): s is string => !!s))];

  const concreteOptions: ComboOption[] = [
    { value: NONE, label: '不设置', group: '' },
    ...['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].map((name) => ({ value: name, label: name, group: '内置', icon: <LineDot color={color(name)} size={8} hollow /> })),
    ...(ws.catalog.names ?? []).map((name) => {
      const info = describeNode(name);
      return { value: name, label: info.label, group: '节点', icon: <Flag region={info.region} size={13} />, keywords: [info.zh ?? ''] };
    }),
  ];
  const dialerOptions: ComboOption[] = [
    { value: NONE, label: '不设置', group: '' },
    ...ws.groups
      .filter((g) => g.name !== groupName)
      .map((g) => ({ value: g.name, label: g.name, group: '策略组', icon: <LineDot color={color(g.name)} size={8} /> })),
    ...concreteOptions.filter((o) => o.group === '节点'),
  ];

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="模版"
        hint="引用模版后，这个组没填的字段会从模版继承。模版在所有配置文件间共享。"
      >
        {(id) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Select
                  id={id}
                  value={draft.templateId || NONE}
                  onValueChange={(value) => set({ templateId: value === NONE ? '' : value })}
                  options={[
                    { value: NONE, label: '不使用模版' },
                    ...(ws.templates ?? []).map((t) => ({ value: t.id, label: t.name, description: t.notes })),
                  ]}
                />
              </div>
              <Button size="md" variant="ghost" onClick={ws.openTemplates}>
                管理模版
              </Button>
            </div>
            {inherited.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                <span>沿用模版：</span>
                {inherited.map(([key, value]) => (
                  <span key={key} className="inline-flex h-5 items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5">
                    <span className="text-ink-3">{TEMPLATE_FIELD_LABELS[key] ?? key}</span>
                    <span className="font-mono text-ink-2">{templateFieldText(key, value)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="空成员兜底" optional hint="自动纳入的节点一个都没有时改用它，避免这条线路失效。">
          {(id) => (
            <Combobox
              id={id}
              value={draft.emptyFallback || null}
              onChange={(value) => set({ emptyFallback: value === NONE ? '' : value })}
              options={concreteOptions}
              placeholder="不设置"
              searchPlaceholder="搜索节点或内置策略…"
            />
          )}
        </Field>
        <Field
          label="前置代理"
          optional
          hint={
            draft.dialerProxy ? (
              <span className="text-warn">
                由「链式代理」页面维护，在这里改动可能打断链路。
                <Link href={ws.path('chains')} className="ml-1 font-medium underline-offset-2 hover:underline">
                  去链式代理
                </Link>
              </span>
            ) : (
              '让这条线路的流量先经过另一个策略组或节点（dialer-proxy）。'
            )
          }
        >
          {(id) => (
            <Combobox
              id={id}
              value={draft.dialerProxy || null}
              onChange={(value) => set({ dialerProxy: value === NONE ? '' : value })}
              options={dialerOptions}
              placeholder="不设置"
              searchPlaceholder="搜索策略组或节点…"
            />
          )}
        </Field>
        <Field label="分组" optional hint="只用于左侧列表归类，不会写进配置。">
          {(id) => (
            <Combobox
              id={id}
              value={draft.section || null}
              onChange={(value) => set({ section: value === NONE ? '' : value })}
              options={[{ value: NONE, label: '不分组' }, ...sections.map((s) => ({ value: s, label: s }))]}
              allowCustom
              customLabel={(query) => <>新建分组「{query}」</>}
              placeholder="不分组"
              searchPlaceholder="输入或选择分组…"
            />
          )}
        </Field>
        <Field label="图标" optional error={errors.icon} hint="部分客户端会显示的图标地址。">
          {(id) => (
            <Input
              id={id}
              mono
              value={draft.icon}
              invalid={!!errors.icon}
              placeholder="https://…/icon.png"
              onChange={(event) => set({ icon: event.target.value })}
            />
          )}
        </Field>
        <Field label="routing-mark" optional error={errors.routingMark} hint="Linux 下给流量打的 SO_MARK，一般不用填。">
          {(id) => (
            <NumberInput id={id} value={draft.routingMark} onChange={(routingMark) => set({ routingMark })} invalid={!!errors.routingMark} />
          )}
        </Field>
        <Field inline label="禁用 UDP" hint="这条线路只转发 TCP。" className="self-end pb-1">
          {(id) => <Switch id={id} checked={!!draft.disableUdp} onCheckedChange={(disableUdp) => set({ disableUdp })} />}
        </Field>
      </div>

      <Field label="备注" optional>
        {(id) => (
          <Textarea
            id={id}
            value={draft.notes}
            rows={2}
            className="min-h-[60px]"
            placeholder="写给自己看的说明，不会写进配置"
            onChange={(event) => set({ notes: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}
