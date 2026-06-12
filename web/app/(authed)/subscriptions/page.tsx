'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { ApiError, api } from '@/lib/client/api';
import { type Collection } from '@/lib/types/collection';
import type { Operator } from '@/schemas/operator';
import styles from './subscriptions.module.css';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface Subscription {
  id: string;
  name: string;
  kind: 'remote' | 'local';
  enabled: boolean;
  url?: string;
  ua_override?: string;
  ttl_ms: number;
  content?: string;
  tags: string[];
  node_prefix?: string;
  last_synced_at?: number;
  last_traffic?: {
    upload: number;
    download: number;
    total: number;
    expire: number;
  };
  last_error?: string;
  operators?: Operator[];
}

type Tab = 'subs' | 'collections';

function fmtTime(s: number | undefined): string {
  if (!s) return '从未';
  const diff = Date.now() / 1000 - s;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  return new Date(s * 1000).toLocaleString('zh-CN');
}

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [collectionAdding, setCollectionAdding] = useState(false);
  const [collectionEditingId, setCollectionEditingId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('subs');
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const tabsId = useId();
  const subsTabRef = useRef<HTMLButtonElement>(null);
  const collectionsTabRef = useRef<HTMLButtonElement>(null);

  const handleTablistKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next: Tab = tab === 'subs' ? 'collections' : 'subs';
        setTab(next);
        requestAnimationFrame(() => {
          (next === 'subs' ? subsTabRef : collectionsTabRef).current?.focus();
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setTab('subs');
        requestAnimationFrame(() => subsTabRef.current?.focus());
      } else if (e.key === 'End') {
        e.preventDefault();
        setTab('collections');
        requestAnimationFrame(() => collectionsTabRef.current?.focus());
      }
    },
    [tab],
  );

  const startBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const endBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Tab 切换时，避免另一 tab 里残留的"编辑/新增"状态泄漏回来
  useEffect(() => {
    setEditingId(null);
    setAdding(false);
    setCollectionAdding(false);
    setCollectionEditingId(null);
  }, [tab]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, cl] = await Promise.all([
        api<{ data: Subscription[] }>('/api/v1/subscriptions'),
        api<{ data: Collection[] }>('/api/v1/collections'),
      ]);
      setSubs(list.data);
      setCollections(cl.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onRefresh(id: string) {
    startBusy(id);
    try {
      await api(`/api/v1/subscriptions/${id}/refresh`, { method: 'POST' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      endBusy(id);
    }
  }

  async function onDelete(id: string) {
    if (!confirm('确定删除该订阅源？')) return;
    startBusy(id);
    try {
      await api(`/api/v1/subscriptions/${id}`, { method: 'DELETE' });
      setSubs((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      endBusy(id);
    }
  }

  async function onToggle(sub: Subscription) {
    startBusy(sub.id);
    try {
      const res = await api<{ data: Subscription }>(`/api/v1/subscriptions/${sub.id}`, {
        method: 'PATCH',
        body: { enabled: !sub.enabled },
      });
      setSubs((prev) => prev.map((s) => (s.id === sub.id ? res.data : s)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      endBusy(sub.id);
    }
  }

  async function onSaveEdit(id: string, patch: Record<string, unknown>) {
    startBusy(id);
    try {
      const res = await api<{ data: Subscription }>(`/api/v1/subscriptions/${id}`, {
        method: 'PATCH',
        body: patch,
      });
      setSubs((prev) => prev.map((s) => (s.id === id ? res.data : s)));
      setEditingId(null);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.problem.detail ?? err.message : String(err);
      setError(msg);
      throw err; // EditForm 内 catch 仍可显示 inline 错误
    } finally {
      endBusy(id);
    }
  }

  async function onCollectionCreate(input: Record<string, unknown>) {
    await api('/api/v1/collections', { method: 'POST', body: input });
    setCollectionAdding(false);
    await reload();
  }
  async function onCollectionSave(id: string, input: Record<string, unknown>) {
    await api(`/api/v1/collections/${id}`, { method: 'PATCH', body: input });
    setCollectionEditingId(null);
    await reload();
  }
  async function onCollectionDelete(id: string) {
    if (!confirm('确定删除该聚合订阅？')) return;
    try {
      await api(`/api/v1/collections/${id}`, { method: 'DELETE' });
      if (collectionEditingId === id) setCollectionEditingId(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const editingCollection =
    collectionEditingId !== null
      ? collections.find((c) => c.id === collectionEditingId) ?? null
      : null;

  const q = query.trim().toLowerCase();
  const filteredSubs = useMemo(() => {
    if (!q) return subs;
    return subs.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [subs, q]);
  const filteredCollections = useMemo(() => {
    if (!q) return collections;
    return collections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.subscription_tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [collections, q]);

  return (
    <>
      <PageTopbar>
        <h1>订阅源</h1>
        <ScopePill shared />
        {loaded && (
          <span className="crumb">
            {subs.length} 单订阅 · {collections.length} 聚合
          </span>
        )}
        <div className="grow" />
        {tab === 'subs' ? (
          <button
            type="button"
            className="btn primary"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? '取消' : '＋ 新建'}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setCollectionEditingId(null);
              setCollectionAdding((v) => !v);
            }}
          >
            {collectionAdding ? '取消' : '＋ 新建聚合订阅'}
          </button>
        )}
      </PageTopbar>

      {/* tabs + 搜索 —— 原型把这行留在内容区首行（新建钮已上移 topbar） */}
      <div className={styles.headRow}>
        <div
          role="tablist"
          aria-label="订阅源类型"
          onKeyDown={handleTablistKey}
          className="tabs"
        >
          <TabButton
            ref={subsTabRef}
            active={tab === 'subs'}
            onClick={() => setTab('subs')}
            count={subs.length}
            controlsId={`${tabsId}-panel-subs`}
            tabId={`${tabsId}-tab-subs`}
          >
            单订阅
          </TabButton>
          <TabButton
            ref={collectionsTabRef}
            active={tab === 'collections'}
            onClick={() => setTab('collections')}
            count={collections.length}
            controlsId={`${tabsId}-panel-collections`}
            tabId={`${tabsId}-tab-collections`}
          >
            聚合订阅
          </TabButton>
        </div>
        <div className={styles.grow} />
        <div className="search" style={{ width: 220 }}>
          <input
            className="input"
            placeholder="搜索名称 / 标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {error && <div className={styles.errBanner}>{error}</div>}

      {tab === 'subs' ? (
        <section
          id={`${tabsId}-panel-subs`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-subs`}
        >
          <div className={styles.lead}>
            订阅源是平台向上游机场拉取的<b>输入</b>；启用后处理并注入 proxies。
            远程源按 <b>缓存 TTL</b> 定时拉取，本地源是内联 YAML / 节点链接。
            源站地址、UA 与节点处理流水线都在「编辑」里维护。
          </div>

          {adding && (
            <AddForm
              onAdded={() => {
                setAdding(false);
                reload();
              }}
              onCancel={() => setAdding(false)}
            />
          )}

          {!loaded ? (
            <div className="panel">
              <SubSkeleton />
              <SubSkeleton />
            </div>
          ) : subs.length === 0 && !adding ? (
            <EmptyState onAdd={() => setAdding(true)} />
          ) : filteredSubs.length === 0 ? (
            <div className="panel">
              <div className={styles.empty}>
                <div className={styles.d}>没有匹配「{query}」的订阅源。</div>
              </div>
            </div>
          ) : (
            <div className="panel">
              {filteredSubs.map((sub) => (
                <Dossier
                  key={sub.id}
                  sub={sub}
                  pending={busyIds.has(sub.id)}
                  editing={editingId === sub.id}
                  anyEditing={editingId !== null}
                  onRefresh={() => onRefresh(sub.id)}
                  onDelete={() => onDelete(sub.id)}
                  onToggle={() => onToggle(sub)}
                  onEditStart={() => setEditingId(sub.id)}
                  onEditCancel={() => setEditingId(null)}
                  onEditSave={(patch) => onSaveEdit(sub.id, patch)}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <section
          id={`${tabsId}-panel-collections`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-collections`}
        >
          <div className={styles.lead}>
            聚合订阅把<b>多条单订阅合并成一个来源</b>，输出一条对外链接。
            在「结构骨架」页把配置文件的「节点来源」绑定到它，就会注入这组订阅去重后的节点。
            成员可手动勾选，也可按标签自动纳入。
          </div>

          {(collectionAdding || editingCollection) && (
            <CollectionForm
              key={editingCollection?.id ?? 'new'}
              subs={subs}
              initial={editingCollection ?? undefined}
              onCancel={() => {
                setCollectionAdding(false);
                setCollectionEditingId(null);
              }}
              onSubmit={(input) =>
                editingCollection
                  ? onCollectionSave(editingCollection.id, input)
                  : onCollectionCreate(input)
              }
            />
          )}

          {!loaded ? (
            <div className="panel">
              <SubSkeleton />
              <SubSkeleton />
            </div>
          ) : collections.length === 0 ? (
            !collectionAdding && <CollectionEmpty onAdd={() => setCollectionAdding(true)} />
          ) : filteredCollections.length === 0 ? (
            <div className="panel">
              <div className={styles.empty}>
                <div className={styles.d}>没有匹配「{query}」的聚合订阅。</div>
              </div>
            </div>
          ) : (
            <div className="panel">
              {filteredCollections.map((c) => (
                <CollectionCard
                  key={c.id}
                  c={c}
                  subs={subs}
                  editing={collectionEditingId === c.id}
                  anyEditing={collectionEditingId !== null || collectionAdding}
                  onEdit={() => {
                    setCollectionAdding(false);
                    setCollectionEditingId(c.id);
                  }}
                  onDelete={() => onCollectionDelete(c.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function TabButton({
  ref,
  active,
  onClick,
  count,
  controlsId,
  tabId,
  children,
}: {
  ref?: RefObject<HTMLButtonElement | null>;
  active: boolean;
  onClick: () => void;
  count: number;
  controlsId: string;
  tabId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={controlsId}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`tab${active ? ' on' : ''}`}
    >
      {children}
      <span className="ct">{count}</span>
    </button>
  );
}

function CollectionEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="panel">
      <div className={styles.empty}>
        <div className={styles.t}>还没有聚合订阅</div>
        <div className={styles.d}>
          聚合订阅把多条单订阅合并成一个来源。在「结构骨架」页把配置文件的「节点来源」绑定到它，就会注入这组订阅的节点。
        </div>
        <button type="button" className="btn primary" onClick={onAdd}>
          ＋ 新建第一个聚合订阅
        </button>
      </div>
    </div>
  );
}

function CollectionCard({
  c,
  subs,
  editing,
  anyEditing,
  onEdit,
  onDelete,
}: {
  c: Collection;
  subs: Subscription[];
  editing: boolean;
  anyEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const subById = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);
  const members = useMemo(() => {
    const ids = new Set(c.subscription_ids);
    if (c.subscription_tags.length > 0) {
      for (const s of subs) {
        if (s.tags?.some((t) => c.subscription_tags.includes(t))) ids.add(s.id);
      }
    }
    return [...ids]
      .map((id) => subById.get(id))
      .filter((s): s is Subscription => !!s);
  }, [c, subs, subById]);

  const hasDisabledMember = members.some((m) => !m.enabled);
  const ledTone = !c.enabled ? 'off' : hasDisabledMember ? 'err' : 'ok';
  const directMembers = members.filter((m) => c.subscription_ids.includes(m.id));

  return (
    <div className={`${styles.subItem}${anyEditing && !editing ? ` ${styles.dimmed}` : ''}`}>
      <span className={`${styles.led} ${styles[ledTone]}`} />
      <div className={styles.subMain}>
        <div className={styles.head}>
          <b>{c.name}</b>
          <span className="pill ai plain">collection</span>
          <span className="pill idle plain">{c.enabled ? '已启用' : '已停用'}</span>
        </div>
        <div className={styles.colLead}>
          合并多个单订阅的节点，去重后输出一条对外链接——在「结构骨架」绑定为节点来源即可。
        </div>
        {(directMembers.length > 0 || c.subscription_tags.length > 0) && (
          <div className={styles.colMembers}>
            {directMembers.length > 0 && (
              <>
                <span className={styles.mk}>直接指定</span>
                {directMembers.slice(0, 6).map((m) => (
                  <span key={m.id} className="tag">
                    {m.name}
                  </span>
                ))}
                {directMembers.length > 6 && (
                  <span className={styles.mk}>+{directMembers.length - 6}</span>
                )}
              </>
            )}
            {c.subscription_tags.length > 0 && (
              <>
                <span className={styles.mk} style={{ marginLeft: 6 }}>
                  标签匹配
                </span>
                {c.subscription_tags.map((t) => (
                  <span key={t} className="chip on" style={{ pointerEvents: 'none' }}>
                    tag: {t}
                  </span>
                ))}
              </>
            )}
          </div>
        )}
        <div className={styles.meta}>
          <span>
            <span className={styles.k}>类型</span> {c.type}
          </span>
          <span>
            <span className={styles.k}>命中成员</span> {members.length} 个
            {hasDisabledMember && (
              <span style={{ color: 'var(--warn)' }}> · 含停用</span>
            )}
          </span>
          {c.updated_at && (
            <span>
              <span className={styles.k}>更新</span> {fmtTime(c.updated_at)}
            </span>
          )}
        </div>
        {c.notes && (
          <div className={styles.meta} title={c.notes}>
            <span>
              <span className={styles.k}>备注</span> {c.notes}
            </span>
          </div>
        )}
      </div>
      <div className={styles.right}>
        <div className={styles.acts}>
          <button
            type="button"
            className="btn sm"
            onClick={onEdit}
            disabled={anyEditing}
          >
            编辑
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={onDelete}
            disabled={anyEditing}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

/** 节点处理入口 —— 跳转全屏流水线工作台；有算子时挂 accent 计数。 */
function PipelineLink({
  subId,
  count,
}: {
  subId: string;
  count: number;
}) {
  const router = useRouter();
  return (
    <a
      href={`/subscriptions/${subId}/pipeline`}
      onClick={(e) => {
        e.preventDefault();
        router.push(`/subscriptions/${subId}/pipeline`);
      }}
    >
      处理流水线{count > 0 ? ` · ${count} 个算子` : ''} →
    </a>
  );
}

/** 聚合订阅的内联新建/编辑表单 —— 勾选单订阅成员 + 标签匹配。 */
function CollectionForm({
  subs,
  initial,
  onSubmit,
  onCancel,
}: {
  subs: Subscription[];
  initial?: Collection;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.subscription_ids ?? []),
  );
  const [tagsInput, setTagsInput] = useState(initial?.subscription_tags?.join(', ') ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagList = useMemo(
    () =>
      tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    [tagsInput],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 合并预览：手选 + 标签命中，启用计数
  const merge = useMemo(() => {
    const ids = new Set(selected);
    if (tagList.length > 0) {
      for (const s of subs) {
        if (s.tags?.some((t) => tagList.includes(t))) ids.add(s.id);
      }
    }
    const members = [...ids]
      .map((id) => subs.find((s) => s.id === id))
      .filter((s): s is Subscription => !!s);
    const active = members.filter((m) => m.enabled);
    return { members, active };
  }, [selected, tagList, subs]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        enabled,
        type: 'select',
        subscription_ids: [...selected],
        subscription_tags: tagList,
        notes: notes.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginBottom: 18 }}>
      <div className={styles.editGrid}>
        {/* 左列 */}
        <div>
          <section className={styles.sec}>
            <div className={styles.secHead}>
              <h2>{initial ? `编辑「${initial.name}」` : '新建聚合订阅'}</h2>
              <span className={styles.n}>collection · 聚合</span>
            </div>
            <div className={styles.frm}>
              <div className={styles.frmRow}>
                <label>
                  名称
                  <span className="h">影响公开链接路径</span>
                </label>
                <div className={styles.ctl}>
                  <input
                    className="input mono"
                    placeholder="例如：聚合订阅1 / 主力机场"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!!initial}
                    required
                  />
                </div>
              </div>
              <div className={styles.frmRow}>
                <label>
                  标签匹配
                  <span className="h">命中任一标签的订阅自动并入</span>
                </label>
                <div className={styles.ctl}>
                  <input
                    className="input mono"
                    placeholder="premium, asia"
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                  />
                </div>
              </div>
              <div className={styles.frmRow}>
                <label>备注</label>
                <div className={styles.ctl}>
                  <input
                    className="input"
                    placeholder="可选"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </div>
              <div className={styles.frmRow}>
                <label>状态</label>
                <div className={`${styles.ctl} ${styles.switchRow}`}>
                  <button
                    type="button"
                    className="switch"
                    aria-pressed={enabled}
                    onClick={() => setEnabled((v) => !v)}
                  />
                  <span className={styles.swNote}>{enabled ? '启用' : '停用'}</span>
                </div>
              </div>
            </div>
          </section>

          <section className={styles.sec}>
            <div className={styles.secHead}>
              <h2>成员来源</h2>
              <span className={styles.n}>手动勾选要并入的单订阅</span>
            </div>
            <div className={styles.memBlock}>
              {subs.length === 0 ? (
                <div className={styles.addLine} style={{ borderTop: 0 }}>
                  <span className={styles.swNote}>
                    还没有订阅源，请先到「单订阅」tab 新增。
                  </span>
                </div>
              ) : (
                subs.map((s) => {
                  const checked = selected.has(s.id);
                  return (
                    <div
                      key={s.id}
                      className={`${styles.mem}${!s.enabled ? ` ${styles.isOff}` : ''}`}
                      onClick={() => toggle(s.id)}
                    >
                      <span
                        className={`${styles.memLed} ${s.enabled ? styles.ok : styles.off}`}
                      />
                      <div className={styles.grow}>
                        <div className={styles.nm}>{s.name}</div>
                        <div className={styles.sub}>
                          {s.kind} · {s.enabled ? '已启用' : '已停用'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="switch"
                        aria-pressed={checked}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(s.id);
                        }}
                      />
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        {/* 右列：合并预览 */}
        <div className={styles.sideStick}>
          <section className="panel">
            <div className="panel-head">
              <h2>合并预览</h2>
              <span className="sub num">{merge.active.length} 启用成员</span>
            </div>
            <div className="panel-body" style={{ padding: '12px 16px' }}>
              {merge.members.length === 0 ? (
                <div className={styles.mergeFoot}>勾选成员或填写标签后在此预览。</div>
              ) : (
                <>
                  {merge.members.map((m) => (
                    <div key={m.id} className={styles.mergeStat}>
                      <div className="r">
                        <span
                          className="k"
                          style={!m.enabled ? { color: 'var(--faint)' } : undefined}
                        >
                          {m.name}
                          {!m.enabled && ' · 停用'}
                        </span>
                        <span className="v">{m.enabled ? '计入' : '0'}</span>
                      </div>
                    </div>
                  ))}
                  <div className={styles.mergeFoot}>
                    {merge.active.length} 个启用成员合并、去重后对外下发
                  </div>
                </>
              )}
            </div>
          </section>

          <div className={styles.editActs}>
            <button type="submit" className="btn primary" disabled={pending || !name}>
              {pending ? '…' : initial ? '保存' : '创建'}
            </button>
            <button type="button" className="btn" onClick={onCancel} disabled={pending}>
              取消
            </button>
          </div>
          {error && <div className={styles.errBanner}>{error}</div>}
        </div>
      </div>
    </form>
  );
}

function SubSkeleton() {
  return (
    <div className={styles.subItem}>
      <span className={`${styles.led} ${styles.off}`} />
      <div className={styles.subMain}>
        <div className={styles.skel} style={{ width: 180, marginBottom: 10 }} />
        <div className={styles.skel} style={{ width: '70%' }} />
      </div>
    </div>
  );
}

function CompactTraffic({
  traffic,
}: {
  traffic: { upload: number; download: number; total: number };
}) {
  const used = traffic.upload + traffic.download;
  const pct = traffic.total > 0 ? Math.min(100, (used / traffic.total) * 100) : 0;
  const hot = pct >= 90;
  return (
    <div className="traffic">
      <div className="lbl">
        <span>已用 {fmtBytes(used)}</span>
        <span>共 {fmtBytes(traffic.total)}</span>
      </div>
      <div className="bar">
        <i className={hot ? 'hot' : undefined} style={{ width: `${pct}%` }} />
      </div>
      <div className="lbl">
        <span>
          ↑ {fmtBytes(traffic.upload)} · ↓ {fmtBytes(traffic.download)}
        </span>
        <span>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!n) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}${units[i]}`;
}

function Dossier({
  sub,
  pending,
  editing,
  anyEditing,
  onRefresh,
  onDelete,
  onToggle,
  onEditStart,
  onEditCancel,
  onEditSave,
}: {
  sub: Subscription;
  pending: boolean;
  editing: boolean;
  anyEditing: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  if (editing) {
    return (
      <div className={`${styles.subItem} ${styles.editing}`}>
        <EditForm sub={sub} onCancel={onEditCancel} onSave={onEditSave} />
      </div>
    );
  }

  const ledTone = sub.last_error ? 'err' : sub.enabled ? 'ok' : 'off';
  const opCount = sub.operators?.length ?? 0;

  return (
    <div className={`${styles.subItem}${anyEditing ? ` ${styles.dimmed}` : ''}`}>
      <span className={`${styles.led} ${styles[ledTone]}`} />
      <div className={styles.subMain}>
        <div className={styles.head}>
          <b>{sub.name}</b>
          <span className={`pill ${sub.kind === 'remote' ? 'acc' : 'idle'} plain`}>
            {sub.kind}
          </span>
          {sub.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
          {sub.last_error && <span className="pill err">上次拉取失败</span>}
          {!sub.enabled && <span className="pill idle">已停用</span>}
        </div>

        {sub.last_error && (
          <div className={styles.errLine}>
            {sub.last_error}
            {sub.kind === 'remote' && ' · 公开链接仍以上次缓存对外下发'}
          </div>
        )}

        <div className={styles.meta}>
          {sub.kind === 'remote' ? (
            <span>
              <span className={styles.k}>缓存 TTL</span> {Math.round(sub.ttl_ms / 1000)}s
            </span>
          ) : (
            <span>
              <span className={styles.k}>内容</span> 内联 YAML
            </span>
          )}
          <span>
            <span className={styles.k}>上次拉取</span> {fmtTime(sub.last_synced_at)}
          </span>
          {sub.node_prefix && (
            <span>
              <span className={styles.k}>前缀</span> {sub.node_prefix}
            </span>
          )}
          <span>
            <PipelineLink subId={sub.id} count={opCount} />
          </span>
        </div>
      </div>

      <div className={styles.right}>
        {sub.last_traffic && sub.last_traffic.total > 0 && (
          <CompactTraffic traffic={sub.last_traffic} />
        )}
        <div className={styles.acts}>
          <button
            type="button"
            className="btn sm"
            onClick={onEditStart}
            disabled={pending || anyEditing}
          >
            编辑
          </button>
          {sub.kind === 'remote' && (
            <button
              type="button"
              className="btn sm"
              onClick={onRefresh}
              disabled={pending || anyEditing || !sub.enabled}
            >
              刷新
            </button>
          )}
          <button
            type="button"
            className="switch"
            aria-pressed={sub.enabled}
            onClick={onToggle}
            disabled={pending || anyEditing}
            title={sub.enabled ? '停用' : '启用'}
          />
          <button
            type="button"
            className="btn sm danger"
            onClick={onDelete}
            disabled={pending || anyEditing}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="panel">
      <div className={styles.empty}>
        <div className={styles.t}>还没有订阅源</div>
        <div className={styles.d}>添加远程订阅 URL 或本地 YAML 内容来开始。</div>
        <button type="button" className="btn primary" onClick={onAdd}>
          ＋ 添加第一个订阅
        </button>
      </div>
    </div>
  );
}

const TTL_PRESETS: { label: string; sec: number }[] = [
  { label: '1h', sec: 3600 },
  { label: '3h', sec: 3 * 3600 },
  { label: '6h', sec: 6 * 3600 },
  { label: '12h', sec: 12 * 3600 },
];

function TtlSeg({
  sec,
  onChange,
  disabled,
}: {
  sec: number;
  onChange: (sec: number) => void;
  disabled?: boolean;
}) {
  const matched = TTL_PRESETS.some((p) => p.sec === sec);
  return (
    <div className="seg">
      {TTL_PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          className={`opt${p.sec === sec ? ' on' : ''}`}
          onClick={() => onChange(p.sec)}
          disabled={disabled}
        >
          {p.label}
        </button>
      ))}
      <input
        type="number"
        min={1}
        className="input"
        style={{ width: 96 }}
        value={Math.round(sec)}
        onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 0))}
        disabled={disabled}
        title="自定义秒数"
        aria-label="缓存 TTL（秒）"
      />
      {!matched && <span className={styles.swNote}>{Math.round(sec)}s</span>}
    </div>
  );
}

function AddForm({
  onAdded,
  onCancel,
}: {
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<'remote' | 'local'>('remote');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [ua, setUa] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [nodePrefix, setNodePrefix] = useState('');
  const [ttlSec, setTtlSec] = useState(Math.round(DEFAULT_TTL_MS / 1000));
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        enabled,
        ttl_ms: Math.max(1000, ttlSec * 1000),
        tags,
      };
      if (nodePrefix.trim()) body.node_prefix = nodePrefix;
      if (kind === 'remote') {
        body.url = url.trim();
        if (ua.trim()) body.ua_override = ua.trim();
      } else {
        body.content = content;
      }
      await api('/api/v1/subscriptions', { method: 'POST', body });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginBottom: 18 }}>
      <section className={styles.sec}>
        <div className={styles.secHead}>
          <h2>新增订阅源</h2>
          <span className={styles.n}>{kind}</span>
        </div>
        <div className={styles.frm}>
          <div className={styles.frmRow}>
            <label>类型</label>
            <div className={styles.ctl}>
              <div className="seg" data-seg="kind">
                <button
                  type="button"
                  className={`opt${kind === 'remote' ? ' on' : ''}`}
                  onClick={() => setKind('remote')}
                >
                  远程 URL
                </button>
                <button
                  type="button"
                  className={`opt${kind === 'local' ? ' on' : ''}`}
                  onClick={() => setKind('local')}
                >
                  内联 YAML
                </button>
              </div>
            </div>
          </div>

          <div className={styles.frmRow}>
            <label>
              名称
              <span className="h">slug · 仅小写字母 / 数字 / -</span>
            </label>
            <div className={styles.ctl}>
              <input
                className="input mono"
                placeholder="airport-a"
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[a-z0-9-]+"
                required
              />
            </div>
          </div>

          {kind === 'remote' && (
            <div className={styles.frmRow}>
              <label>
                缓存 TTL
                <span className="h">拉取间隔</span>
              </label>
              <div className={styles.ctl}>
                <TtlSeg sec={ttlSec} onChange={setTtlSec} />
              </div>
            </div>
          )}

          <div className={styles.frmRow}>
            <label>标签</label>
            <div className={styles.ctl}>
              <input
                className="input mono"
                placeholder="premium, asia"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.frmRow}>
            <label>
              节点名前缀
              <span className="h">可选 · 避免跨源同名被去重丢弃</span>
            </label>
            <div className={styles.ctl}>
              <input
                className="input mono"
                placeholder="[Airport-A] "
                value={nodePrefix}
                onChange={(e) => setNodePrefix(e.target.value)}
              />
            </div>
          </div>

          {kind === 'remote' ? (
            <>
              <div className={styles.frmRow}>
                <label>
                  上游 URL
                  <span className="h">仅平台拉取</span>
                </label>
                <div className={styles.ctl}>
                  <input
                    className="input mono"
                    type="url"
                    placeholder="https://airport/sub?token=…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className={styles.frmRow}>
                <label>UA 覆写</label>
                <div className={styles.ctl}>
                  <input
                    className="input mono"
                    placeholder="可选，如 clash.meta/1.18.0"
                    value={ua}
                    onChange={(e) => setUa(e.target.value)}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className={styles.frmRow} style={{ alignItems: 'start' }}>
              <label>
                节点内容
                <span className="h">clash yaml · 或多行 ss:// vmess:// vless:// trojan:// hy2:// … · 或 base64</span>
              </label>
              <div className={styles.ctl}>
                <CodeEditor
                  value={content}
                  onChange={setContent}
                  label="content · yaml / links"
                  minHeight={200}
                  hint="粘贴节点链接或 Clash YAML"
                />
              </div>
            </div>
          )}

          <div className={styles.frmRow}>
            <label>状态</label>
            <div className={`${styles.ctl} ${styles.switchRow}`}>
              <button
                type="button"
                className="switch"
                aria-pressed={enabled}
                onClick={() => setEnabled((v) => !v)}
              />
              <span className={styles.swNote}>{enabled ? '立即启用' : '创建后停用'}</span>
            </div>
          </div>
        </div>
      </section>

      <div className={styles.editActs}>
        <button type="submit" className="btn primary" disabled={pending || !name}>
          {pending ? '提交中…' : '创建'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
      </div>
      {error && <div className={styles.errBanner} style={{ marginTop: 12 }}>{error}</div>}
    </form>
  );
}

function EditForm({
  sub,
  onCancel,
  onSave,
}: {
  sub: Subscription;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(sub.name);
  const [url, setUrl] = useState(sub.url ?? '');
  const [content, setContent] = useState(sub.content ?? '');
  const [ua, setUa] = useState(sub.ua_override ?? '');
  const [tagsInput, setTagsInput] = useState(sub.tags.join(', '));
  const [nodePrefix, setNodePrefix] = useState(sub.node_prefix ?? '');
  const [ttlSec, setTtlSec] = useState(Math.max(1, Math.round(sub.ttl_ms / 1000)));
  const [enabled, setEnabled] = useState(sub.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const patch: Record<string, unknown> = {
        name: name.trim(),
        enabled,
        ttl_ms: Math.max(1000, ttlSec * 1000),
        tags,
        // Sending empty string clears the field; the API treats undefined as "no change".
        node_prefix: nodePrefix,
      };
      if (sub.kind === 'remote') {
        patch.url = url.trim();
        patch.ua_override = ua.trim();
      } else {
        patch.content = content;
      }
      await onSave(patch);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ width: '100%' }}>
      <div className={styles.secHead}>
        <h2>编辑订阅源</h2>
        <span className={styles.n}>{sub.kind} · 类型不可改</span>
        <span className={styles.grow} />
      </div>
      <div className={styles.frm}>
        <div className={styles.frmRow}>
          <label>
            名称
            <span className="h">slug</span>
          </label>
          <div className={styles.ctl}>
            <input
              className="input mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-z0-9-]+"
              required
            />
          </div>
        </div>

        {sub.kind === 'remote' && (
          <div className={styles.frmRow}>
            <label>
              缓存 TTL
              <span className="h">拉取间隔</span>
            </label>
            <div className={styles.ctl}>
              <TtlSeg sec={ttlSec} onChange={setTtlSec} />
            </div>
          </div>
        )}

        <div className={styles.frmRow}>
          <label>标签</label>
          <div className={styles.ctl}>
            <input
              className="input mono"
              placeholder="premium, asia"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.frmRow}>
          <label>
            节点名前缀
            <span className="h">可选 · 避免跨源同名被去重丢弃</span>
          </label>
          <div className={styles.ctl}>
            <input
              className="input mono"
              placeholder="[Airport-A] "
              value={nodePrefix}
              onChange={(e) => setNodePrefix(e.target.value)}
            />
          </div>
        </div>

        {sub.kind === 'remote' ? (
          <>
            <div className={styles.frmRow}>
              <label>
                上游 URL
                <span className="h">仅平台拉取</span>
              </label>
              <div className={styles.ctl}>
                <input
                  className="input mono"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className={styles.frmRow}>
              <label>UA 覆写</label>
              <div className={styles.ctl}>
                <input
                  className="input mono"
                  placeholder="留空 = 不覆写"
                  value={ua}
                  onChange={(e) => setUa(e.target.value)}
                />
              </div>
            </div>
          </>
        ) : (
          <div className={styles.frmRow} style={{ alignItems: 'start' }}>
            <label>
              节点内容
              <span className="h">clash yaml · 或多行节点链接 · 或 base64</span>
            </label>
            <div className={styles.ctl}>
              <CodeEditor
                value={content}
                onChange={setContent}
                label="content · yaml / links"
                minHeight={200}
                hint="编辑节点链接或 Clash YAML"
              />
            </div>
          </div>
        )}

        <div className={styles.frmRow}>
          <label>状态</label>
          <div className={`${styles.ctl} ${styles.switchRow}`}>
            <button
              type="button"
              className="switch"
              aria-pressed={enabled}
              onClick={() => setEnabled((v) => !v)}
            />
            <span className={styles.swNote}>{enabled ? '启用' : '停用'}</span>
          </div>
        </div>
      </div>

      <div className={styles.editActs} style={{ marginTop: 16 }}>
        <button type="submit" className="btn primary" disabled={pending || !name.trim()}>
          {pending ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
      </div>
      {error && <div className={styles.errBanner} style={{ marginTop: 12 }}>{error}</div>}
    </form>
  );
}
