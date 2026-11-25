'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Boxes, Check, GripVertical, Link2, MoreHorizontal, Plus, Power, PowerOff, RotateCcw, Tag, Trash2, X } from 'lucide-react';
import { DataView } from '@/ui/agent';
import { errorMessage } from '@/ui/data/api';
import { refreshShared, usePool, usePools, useSources } from '@/ui/data/hooks';
import { cn } from '@/ui/lib/cn';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  Field,
  Input,
  Menu,
  MultiCombobox,
  notify,
  Skeleton,
  Switch,
  TabPanel,
  Tabs,
  TagInput,
  Textarea,
  Tooltip,
  useCopy,
} from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { Page, PageHeader, SaveBar } from '@/ui/shell/page';
import { HealthPill, sourceHealth } from '@/ui/viz/health';
import { PipelineEditor } from '@/ui/pipeline/pipeline-editor';
import { NamingLink, NamingSetupPrompt } from './naming-entry';
import { deletePool, patchPool, setPoolEnabled } from './actions';
import { activeMembers, knownNodeCount, poolLink, poolLinkKey, resolvePoolMembers, sourceTitle, stableKey, validateTag, type Pool, type Source } from './model';
import { DistributionPanel, NodesPanel, TAB_SCROLL, UsagePanel, useSubBase, useTabParam } from './shared';
import { Monogram } from '@/ui/primitives';

const TABS = ['members', 'nodes', 'pipeline', 'settings', 'usage', 'share'] as const;

/* ─── members ────────────────────────────────────────────────────────── */

function MemberRow({ id, source, onRemove }: { id: string; source: Source | null; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const title = source ? sourceTitle(source) : '已删除的订阅源';
  const count = source ? knownNodeCount(source) : null;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 10 : undefined, position: 'relative' }}
      className={cn('flex items-center gap-3 bg-surface px-3 py-2.5', isDragging && 'rounded-lg shadow-lg ring-1 ring-accent-line')}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`拖动「${title}」调整顺序`}
        className="flex size-5 cursor-grab touch-none items-center justify-center rounded text-ink-4 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <GripVertical size={14} />
      </button>
      <Monogram name={title} colorKey={id} size={28} className={cn(!source?.enabled && 'opacity-40 grayscale')} />
      <div className="min-w-0 flex-1">
        {source ? (
          <Link href={`/sources/${id}`} className={cn('truncate text-[13px] font-medium hover:underline underline-offset-4', source.enabled ? 'text-ink' : 'text-ink-3')}>
            {title}
          </Link>
        ) : (
          <span className="text-[13px] text-ink-3">{title}</span>
        )}
        <div className="truncate text-[11px] text-ink-3">
          {source ? (
            <>
              <span className="font-mono">{source.name}</span>
              {!source.enabled ? ' · 已停用，不提供节点' : count !== null ? ` · ${count} 个节点` : ''}
            </>
          ) : (
            '它已经不存在了，保存时会从成员里移除'
          )}
        </div>
      </div>
      {source && <HealthPill view={sourceHealth(source)} className="hidden sm:inline-flex" />}
      <Tooltip content="从成员中移除">
        <Button size="sm" variant="ghost" iconOnly icon={X} aria-label={`移除「${title}」`} onClick={onRemove} />
      </Tooltip>
    </li>
  );
}

function MembersPanel({ pool, sources, active }: { pool: Pool; sources: Source[]; active: boolean }) {
  const [ids, setIds] = useState(pool.subscription_ids);
  const [tags, setTags] = useState(pool.subscription_tags);
  const [saving, setSaving] = useState(false);
  const dirty = stableKey(ids) !== stableKey(pool.subscription_ids) || stableKey(tags) !== stableKey(pool.subscription_tags);
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const tagged = resolvePoolMembers({ subscription_ids: ids, subscription_tags: tags }, sources).filter((m) => m.via === 'tag');
  const allTags = useMemo(() => [...new Set(sources.flatMap((s) => s.tags))].sort(), [sources]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const options = sources.map((s) => ({
    value: s.id,
    label: sourceTitle(s),
    keywords: [s.name, ...s.tags],
    description: s.name + (s.enabled ? '' : ' · 已停用'),
    icon: <Monogram name={sourceTitle(s)} colorKey={s.id} size={18} />,
  }));

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await patchPool(pool, { subscription_ids: ids.filter((id) => byId.has(id)), subscription_tags: tags });
      notify.success('成员已保存');
      refreshShared();
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };
  useHotkey('mod+s', () => void save(), { enabled: active && dirty });

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    setIds((current) => arrayMove(current, current.indexOf(String(dragged.id)), current.indexOf(String(over.id))));
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-ink">手动选择 · {ids.length}</h3>
            <p className="mt-0.5 text-xs text-ink-3">按顺序合并，节点重名时保留排在前面的那个。拖动调整顺序。</p>
          </div>
          <MultiCombobox
            label="成员订阅源"
            className="[&>span]:hidden"
            value={ids}
            onChange={setIds}
            options={options}
            align="end"
            searchPlaceholder="搜索订阅源"
            emptyText="没有订阅源"
            trigger={
              <Button size="sm" icon={Plus}>
                添加订阅源
              </Button>
            }
          />
        </div>
        {ids.length === 0 ? (
          <Card>
            <EmptyState compact icon={Boxes} title="还没有手动选择的订阅源" description="点击「添加订阅源」，或者在下面按标签自动收录。" />
          </Card>
        ) : (
          <DataView
            label="聚合订阅成员顺序"
            summary={`已手动选择 ${ids.length} 个订阅源`}
            items={ids.map((id, idx) => {
              const s = byId.get(id);
              return { value: id, label: `${idx + 1}. ${s ? sourceTitle(s) : '已删除的订阅源'}` };
            })}
          >
            <Card className="overflow-hidden">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                  <ol className="divide-y divide-line">
                    {ids.map((id) => (
                      <MemberRow key={id} id={id} source={byId.get(id) ?? null} onRemove={() => setIds(ids.filter((x) => x !== id))} />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            </Card>
          </DataView>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight text-ink">按标签自动加入</h3>
          <p className="mt-0.5 text-xs text-ink-3">带这些标签的订阅源会自动加入，以后新加的订阅源也一样；它们排在手动选择的后面。</p>
        </div>
        <TagInput aria-label="自动加入标签" value={tags} onChange={setTags} validate={validateTag} placeholder="输入标签，回车添加" />
        {allTags.filter((t) => !tags.includes(t)).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            现有标签：
            {allTags
              .filter((t) => !tags.includes(t))
              .map((tag) => (
                <UiButton
                  key={tag}
                  type="button"
                  aria-label={`添加标签 ${tag}`}
                  onClick={() => setTags([...tags, tag])}
                  className="rounded-md border border-line bg-surface px-1.5 py-px text-ink-2 hover:border-line-strong hover:text-ink"
                >
                  + {tag}
                </UiButton>
              ))}
          </div>
        )}
        {tags.length > 0 && (
          <Card className="divide-y divide-line">
            {tagged.length === 0 ? (
              <p className="px-4 py-3 text-xs text-ink-3">目前没有其他订阅源带这些标签。</p>
            ) : (
              tagged.map((m) => (
                <div key={m.id} className={cn('flex items-center gap-3 px-4 py-2.5', !m.source?.enabled && 'opacity-60')}>
                  <Monogram name={m.source ? sourceTitle(m.source) : '?'} colorKey={m.id} size={24} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/sources/${m.id}`} className="truncate text-[13px] font-medium text-ink hover:underline underline-offset-4">
                      {m.source ? sourceTitle(m.source) : m.id}
                    </Link>
                    {!m.source?.enabled && <span className="ml-2 text-[11px] text-ink-3">已停用，不提供节点</span>}
                  </div>
                  <span className="flex flex-wrap gap-1">
                    {m.matchedTags.map((t) => (
                      <Badge key={t} tone="accent" icon={Tag}>
                        {t}
                      </Badge>
                    ))}
                  </span>
                </div>
              ))
            )}
          </Card>
        )}
      </section>

      <SaveBar
        visible={dirty}
        saving={saving}
        confirmHint={`保存聚合订阅「${pool.name}」的成员修改`}
        onSave={() => void save()}
        onDiscard={() => {
          setIds(pool.subscription_ids);
          setTags(pool.subscription_tags);
        }}
      />
    </div>
  );
}

/* ─── settings ───────────────────────────────────────────────────────── */

function PoolSettings({ pool, active }: { pool: Pool; active: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(pool.name);
  const [notes, setNotes] = useState(pool.notes ?? '');
  const [enabled, setEnabled] = useState(pool.enabled);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== pool.name || notes.trim() !== (pool.notes ?? '') || enabled !== pool.enabled;
  const nameError = name.trim() ? null : '请填写名称';

  const save = async () => {
    if (saving || !dirty || nameError) return;
    setSaving(true);
    try {
      await patchPool(pool, {
        ...(name.trim() !== pool.name ? { name: name.trim() } : {}),
        ...(notes.trim() !== (pool.notes ?? '') ? { notes: notes.trim() ? notes.trim() : null } : {}),
        ...(enabled !== pool.enabled ? { enabled } : {}),
      });
      notify.success('设置已保存');
      refreshShared();
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };
  useHotkey('mod+s', () => void save(), { enabled: active && dirty });

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card className="flex flex-col gap-4 p-4">
        <Field label="名称" error={nameError}>
          {(id) => <Input id={id} value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="标识" hint="用在分发链接 /collection/<标识> 里，创建后不能修改。">
          {(id) => (
            <Input
              id={id}
              mono
              readOnly
              value={poolLinkKey(pool)}
              className="bg-surface-2 text-ink-2"
              trailing={<CopyButton text={poolLinkKey(pool)} size="sm" label="复制标识" />}
            />
          )}
        </Field>
        <Field label="备注" optional>
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="写给自己看的说明" />}
        </Field>
        <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
          <div>
            <div className="text-[13px] font-medium text-ink">启用</div>
            <p className="mt-0.5 text-xs text-ink-3">停用后绑定它的配置文件拿不到这些节点。</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} label="启用这个聚合订阅" />
        </div>
      </Card>
      <Card className="flex items-center justify-between gap-4 p-4">
        <div>
          <div className="text-[13px] font-medium text-ink">删除聚合订阅</div>
          <p className="mt-0.5 text-xs text-ink-3">成员订阅源不受影响；绑定它的配置文件会失去节点来源。</p>
        </div>
        <Button variant="danger-ghost" icon={Trash2} onClick={async () => (await deletePool(pool)) && router.push('/sources?tab=pools')}>
          删除
        </Button>
      </Card>
      <SaveBar
        visible={dirty}
        saving={saving}
        confirmHint={`保存聚合订阅「${pool.name}」的设置修改`}
        onSave={() => void save()}
        onDiscard={() => {
          setName(pool.name);
          setNotes(pool.notes ?? '');
          setEnabled(pool.enabled);
        }}
      />
    </div>
  );
}

/* ─── page ───────────────────────────────────────────────────────────── */

export function PoolDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const detail = usePool(id);
  const list = usePools();
  const sources = useSources();
  const pool = detail.data ?? list.data?.find((p) => p.id === id);
  const subBase = useSubBase();
  const { tab, setTab, visited } = useTabParam(TABS, 'members');
  const { copied, copy } = useCopy();
  const [pipelineDirty, setPipelineDirty] = useState(false);

  if (!pool) {
    if (detail.error) {
      const missing = (detail.error as { status?: number }).status === 404;
      return (
        <Page>
          <PageHeader title={missing ? '找不到这个聚合订阅' : '加载失败'} back={{ href: '/sources?tab=pools', label: '聚合订阅' }} />
          <EmptyState
            icon={Boxes}
            title={missing ? '它可能已经被删除了' : errorMessage(detail.error)}
            actions={
              missing ? (
                <Button asChild variant="secondary">
                  <Link href="/sources?tab=pools">回到聚合订阅</Link>
                </Button>
              ) : (
                <Button icon={RotateCcw} onClick={() => void detail.refetch()}>
                  重试
                </Button>
              )
            }
          />
        </Page>
      );
    }
    return (
      <Page>
        <div className="flex flex-col gap-4 pt-9">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="mt-6 h-64 w-full rounded-xl" />
        </div>
      </Page>
    );
  }

  const all = sources.data ?? [];
  const members = resolvePoolMembers(pool, all);
  const live = activeMembers(members);
  const link = subBase ? poolLink(subBase, pool) : null;

  return (
    <Page>
      <PageHeader
        back={{ href: '/sources?tab=pools', label: '聚合订阅' }}
        documentTitle={`${pool.name} · 聚合订阅`}
        eyebrow={
          <>
            <span>聚合订阅</span>
            <span className="font-mono text-[11px] text-ink-2">{poolLinkKey(pool)}</span>
            {!pool.enabled && <Badge>已停用</Badge>}
          </>
        }
        title={
          <span className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[28%] border border-line bg-surface-2 text-ink-2">
              <Boxes size={18} strokeWidth={1.75} />
            </span>
            <span className="min-w-0 truncate">{pool.name}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex -space-x-1.5">
              {members.slice(0, 6).map((m) => (
                <Monogram key={m.id} name={m.source ? sourceTitle(m.source) : '?'} colorKey={m.id} size={20} className={cn('ring-2 ring-panel', !m.source?.enabled && 'opacity-40 grayscale')} />
              ))}
            </span>
            <span>
              合并 {live.length} 个订阅源的节点{members.length > live.length ? `（另有 ${members.length - live.length} 个已停用）` : ''}
              {pool.notes ? ` · ${pool.notes}` : ''}
            </span>
          </span>
        }
        actions={
          <>
            <NamingLink href={`/pools/${pool.id}/naming`} dirty={pipelineDirty} />
            <Button icon={copied ? Check : Link2} disabled={!link} onClick={() => link && void copy(link, '已复制分发链接')}>
              复制链接
            </Button>
            <Menu
              items={[
                pool.enabled
                  ? { label: '停用', icon: PowerOff, confirm: `停用聚合订阅「${pool.name}」`, onSelect: () => void setPoolEnabled(pool, false) }
                  : { label: '启用', icon: Power, confirm: `启用聚合订阅「${pool.name}」`, onSelect: () => void setPoolEnabled(pool, true) },
                { label: '删除', icon: Trash2, tone: 'danger' as const, onSelect: async () => (await deletePool(pool)) && router.push('/sources?tab=pools') },
              ]}
              trigger={<Button iconOnly icon={MoreHorizontal} aria-label="更多操作" />}
            />
          </>
        }
      />

      <Tabs
        label="聚合订阅详情标签页"
        value={tab}
        onValueChange={setTab}
        className={TAB_SCROLL}
        tabs={[
          { value: 'members', label: '成员', count: members.length },
          { value: 'nodes', label: '节点' },
          { value: 'pipeline', label: '处理流程', count: pool.operators.length || undefined },
          { value: 'settings', label: '设置' },
          { value: 'usage', label: '使用情况' },
          { value: 'share', label: '分发' },
        ]}
      >
        <div className="pt-6">
          {visited.has('members') && (
            <TabPanel value="members" forceMount className="outline-none data-[state=inactive]:hidden">
              {sources.isLoading ? (
                <Skeleton className="h-40 rounded-xl" />
              ) : (
                <MembersPanel key={pool.updated_at ?? 0} pool={pool} sources={all} active={tab === 'members'} />
              )}
            </TabPanel>
          )}
          {visited.has('nodes') && (
            <TabPanel value="nodes" forceMount className="outline-none data-[state=inactive]:hidden">
              <NodesPanel target={{ kind: 'collection', id: pool.id }} operators={pool.operators} version={pool.updated_at} enabled={pool.enabled} />
            </TabPanel>
          )}
          {visited.has('pipeline') && (
            <TabPanel value="pipeline" forceMount className="outline-none data-[state=inactive]:hidden">
              <NamingSetupPrompt href={`/pools/${pool.id}/naming`} operators={pool.operators} dirty={pipelineDirty} />
              <PipelineEditor
                target={{ kind: 'collection', id: pool.id }}
                operators={pool.operators}
                updatedAt={pool.updated_at}
                namingHref={`/pools/${pool.id}/naming`}
                onDirtyChange={setPipelineDirty}
                active={tab === 'pipeline'}
                originHint={`${live.length} 个成员订阅源各自处理后合并`}
              />
            </TabPanel>
          )}
          {visited.has('settings') && (
            <TabPanel value="settings" forceMount className="outline-none data-[state=inactive]:hidden">
              <PoolSettings key={pool.updated_at ?? 0} pool={pool} active={tab === 'settings'} />
            </TabPanel>
          )}
          {visited.has('usage') && (
            <TabPanel value="usage" forceMount className="outline-none data-[state=inactive]:hidden">
              <UsagePanel kind="collection" id={pool.id} />
            </TabPanel>
          )}
          {visited.has('share') && (
            <TabPanel value="share" forceMount className="outline-none data-[state=inactive]:hidden">
              <DistributionPanel label={pool.name} path={(base) => poolLink(base, pool)} />
            </TabPanel>
          )}
        </div>
      </Tabs>
    </Page>
  );
}
