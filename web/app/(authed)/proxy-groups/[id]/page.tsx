'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { useUnsavedGuard } from '@/lib/client/useUnsavedGuard';
import { PageTopbar } from '@/components/PageChrome';
import type { ProxyGroup } from '@/schemas';
import { GroupEditor } from '../_components/GroupEditor';
import { fromGroup, toPayload, type FormState } from '../_lib/model';
import { useProxyGroupsData } from '../_lib/useProxyGroupsData';
import styles from '../proxyGroups.module.css';

/**
 * 策略组详情 — DETAIL route (v2 /proxy-group-detail.html). Always-edit.
 *
 * 对齐原型,页头整段放在 topbar:返回链 / 等宽组名 / 类型 pill / 未保存点 /
 * `rank · section` crumb / 保存(⌘S)。内容区直接从 detail-grid 开始;
 * 危险区与元信息面板经 props 注入 GroupEditor 的左/右列。
 */
export default function ProxyGroupDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const data = useProxyGroupsData();
  const {
    groups,
    templates,
    subs,
    nodeNames,
    nodesBySub,
    previewError,
    loaded,
    reload,
    reloadPreview,
    refSummaryFor,
  } = data;

  const group = useMemo<ProxyGroup | null>(
    () => groups.find((g) => g.id === id) ?? null,
    [groups, id],
  );

  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the form whenever the group lands (or changes after a reload).
  useEffect(() => {
    if (group) setForm(fromGroup(group));
  }, [group]);

  const refSummary = group ? refSummaryFor(group) : null;
  const referenced =
    !!refSummary &&
    (refSummary.rules > 0 || refSummary.refIn.length > 0 || refSummary.refOut.length > 0);

  // 未保存标记:表单序列化后的 payload 与存储态不一致即 dirty。
  const dirty = useMemo(() => {
    if (!group || !form) return false;
    return JSON.stringify(toPayload(form)) !== JSON.stringify(toPayload(fromGroup(group)));
  }, [group, form]);
  useUnsavedGuard(dirty); // P1-6

  async function onSubmit() {
    if (!form || !group) return;
    // P2-11: never double-save (⌘S while a save is in flight) or write a no-op
    // history entry for a clean form.
    if (busy || !dirty) return;
    if (!form.name.trim()) {
      setError('请填写策略组名称。');
      return;
    }
    const renaming = form.name.trim() !== group.name;
    const refIn = refSummary?.refIn.length ?? 0;
    const rules = refSummary?.rules ?? 0;
    if (renaming && refIn + rules > 0) {
      const ok = confirm(
        `「${group.name}」被 ${rules} 条规则 + ${refIn} 个策略组引用。\n改名为「${form.name.trim()}」会自动同步这些引用。继续?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/proxy-groups/${group.id}`, { method: 'PATCH', body: toPayload(form) });
      await Promise.all([reload(), reloadPreview()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // ⌘S / Ctrl+S → 保存(与 topbar 按钮等价)。
  // P2-11: keep the latest onSubmit in a ref, but assign it from an effect (not
  // during render — that tripped the react-hooks/refs lint error). onSubmit
  // itself guards busy/dirty, so ⌘S can't double-save or write a no-op.
  const submitRef = useRef(onSubmit);
  useEffect(() => {
    submitRef.current = onSubmit;
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void submitRef.current();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function onDelete() {
    if (!group) return;
    if (!confirm(`确定删除策略组「${group.name}」?被引用时会拒绝删除。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/proxy-groups/${group.id}`, { method: 'DELETE' });
      router.push('/proxy-groups');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!loaded || (group && !form)) {
    return <p className={styles.empty}>载入策略组…</p>;
  }

  if (!group || !form) {
    return (
      <>
        <PageTopbar contentMaxWidth={1280}>
          <Link className={styles.back} href="/proxy-groups">
            ‹ 策略组
          </Link>
          <h1>未找到</h1>
          <div className="grow" />
        </PageTopbar>
        <section className="panel">
          <div className="panel-body">
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
              未找到该策略组(可能已被删除)。
              <Link href="/proxy-groups" style={{ color: 'var(--accent)', marginLeft: 6 }}>
                返回列表 →
              </Link>
            </p>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageTopbar contentMaxWidth={1280}>
        <Link className={styles.back} href="/proxy-groups">
          ‹ 策略组
        </Link>
        <h1 className={styles.tbName}>{group.name}</h1>
        <span className="pill acc plain">{form.type}</span>
        {dirty && (
          <span className="is-dirty" style={{ display: 'inline-flex' }}>
            <span className="unsaved-dot" title="有未保存修改" />
          </span>
        )}
        <div className="grow" />
        <span className="crumb">
          rank {group.rank}
          {group.section ? ` · ${group.section}` : ''}
        </span>
        <button className="btn primary sm" onClick={onSubmit} disabled={busy || !dirty}>
          {busy ? '保存中…' : '保存'} <span className="kbd">⌘S</span>
        </button>
      </PageTopbar>

      {error && (
        <div
          className="pill err"
          style={{ height: 'auto', padding: '8px 12px', marginBottom: 16, display: 'flex' }}
        >
          {error}
        </div>
      )}

      <GroupEditor
        form={form}
        setForm={setForm}
        templates={templates}
        subs={subs}
        groups={groups}
        nodeNames={nodeNames}
        nodesBySub={nodesBySub}
        previewError={previewError}
        isCreate={false}
        originalName={group.name}
        refSummary={refSummary}
        busy={busy}
        onSubmit={onSubmit}
        onCancel={() => router.push('/proxy-groups')}
        dangerZone={
          <section className={`panel ${styles.dangerZone}`}>
            <div className={`panel-head ${styles.panelHead}`}>
              <h2>删除策略组</h2>
            </div>
            <div
              className="panel-body"
              style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: 240,
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  lineHeight: 1.5,
                }}
              >
                {referenced
                  ? '仍有规则 / 组 / dialer-proxy 引用本组,先把引用改到其他出口才能删除 — 不会出现静默悬挂的引用。'
                  : '删除后不可恢复。'}
              </div>
              <button
                className="btn danger"
                onClick={onDelete}
                disabled={busy}
                title={referenced ? '存在引用,后端会拒绝删除' : undefined}
              >
                删除 {group.name}
              </button>
            </div>
          </section>
        }
        asideExtra={<MetaPanel group={group} />}
      />
    </>
  );
}

/** 元信息面板(原型右列末尾):id / 创建 / 最后修改,链到操作历史。 */
function MetaPanel({ group }: { group: ProxyGroup }) {
  // 存储层时间戳为秒(nowSeconds)。
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleString('zh-CN', {
      hour12: false,
      dateStyle: 'short',
      timeStyle: 'short',
    });
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>元信息</h2>
      </div>
      <div className="panel-body" style={{ padding: 14 }}>
        <div className={styles.refList}>
          <div className={styles.refRow}>
            <span className={styles.k}>id</span>
            <span className={styles.v} title={group.id}>
              {group.id.length > 12 ? `${group.id.slice(0, 4)}…${group.id.slice(-4)}` : group.id}
            </span>
          </div>
          {group.created_at !== undefined && (
            <div className={styles.refRow}>
              <span className={styles.k}>创建</span>
              <span className={styles.v}>{fmt(group.created_at)}</span>
            </div>
          )}
          <div className={styles.refRow}>
            <span className={styles.k}>最后修改</span>
            <span className={styles.v}>{fmt(group.updated_at)}</span>
          </div>
        </div>
        <Link
          className={styles.refRow}
          href="/history"
          style={{ color: 'var(--accent)', marginTop: 4 }}
        >
          在操作历史中查看变更 →
        </Link>
      </div>
    </section>
  );
}
