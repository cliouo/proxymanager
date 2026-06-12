'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import type { ProxyGroup, ProxyGroupKind } from '@/schemas';
import { GroupEditor } from '../_components/GroupEditor';
import { IntentPicker } from '../_components/IntentPicker';
import { EMPTY_FORM, KIND_LABELS, presetDefaults, toPayload, type FormState } from '../_lib/model';
import { useProxyGroupsData } from '../_lib/useProxyGroupsData';
import styles from '../proxyGroups.module.css';

/**
 * 新建策略组 — NEW route (v2 /proxy-group-new.html).
 *
 * 对齐原型,页头(返回链 / 标题 / scope pill)放在 topbar。
 * Step 1 IntentPicker (kind) → Step 2 GroupEditor in create mode, pre-filled
 * via presetDefaults(kind). Submit → POST, then redirect to the created
 * group's detail route.
 */
export default function ProxyGroupNewPage() {
  const router = useRouter();
  const data = useProxyGroupsData();
  const { templates, subs, groups, nodeNames, previewError, loaded, reload, reloadPreview } = data;

  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickKind(kind: ProxyGroupKind) {
    setForm({ ...EMPTY_FORM, kind, ...presetDefaults(kind) });
    setError(null);
  }

  async function onSubmit() {
    if (!form) return;
    if (!form.name.trim()) {
      setError('请填写策略组名称。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ data: ProxyGroup }>('/api/v1/proxy-groups', {
        method: 'POST',
        body: toPayload(form),
      });
      await Promise.all([reload(), reloadPreview()]);
      router.push(`/proxy-groups/${res.data.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!loaded) {
    return <p className={styles.empty}>载入策略组…</p>;
  }

  return (
    <>
      <PageTopbar contentMaxWidth={1280}>
        <Link className={styles.back} href="/proxy-groups">
          ‹ 策略组
        </Link>
        <h1>新建策略组</h1>
        <ScopePill />
        <div className="grow" />
      </PageTopbar>

      {error && (
        <div
          className="pill err"
          style={{ height: 'auto', padding: '8px 12px', marginBottom: 16, display: 'flex' }}
        >
          {error}
        </div>
      )}

      {!form ? (
        <IntentPicker onPick={pickKind} onCancel={() => router.push('/proxy-groups')} />
      ) : (
        <>
          <div className={styles.stepRow}>
            <button type="button" className={styles.back} onClick={() => setForm(null)}>
              ‹ 换场景
            </button>
            <span className="crumb">{KIND_LABELS[form.kind]} · 预设只是起点,创建后所有字段仍可改</span>
          </div>
          <GroupEditor
            form={form}
            setForm={setForm}
            templates={templates}
            subs={subs}
            groups={groups}
            nodeNames={nodeNames}
            previewError={previewError}
            isCreate
            originalName=""
            refSummary={null}
            busy={busy}
            onSubmit={onSubmit}
            onCancel={() => router.push('/proxy-groups')}
          />
        </>
      )}
    </>
  );
}
