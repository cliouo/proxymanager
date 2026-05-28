'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Placeholder } from '@/components/ui/Reveal';
import { ApiError, api } from '@/lib/client/api';
import type { ProxyGroup, ProxyGroupKind, ProxyGroupTemplate } from '@/schemas';
import {
  EMPTY_FORM,
  fromGroup,
  presetDefaults,
  toPayload,
  type FormState,
  type SubscriptionLite,
} from './_lib/model';
import { memberStat, usePreviewNodes } from './_lib/useAvailableMembers';
import { GroupDetail } from './_components/GroupDetail';
import { GroupEditor, type RefSummary } from './_components/GroupEditor';
import { IntentPicker } from './_components/IntentPicker';
import { LeftRail } from './_components/LeftRail';

/**
 * 策略组工作台 — structured rail + a member-composer-first editor.
 *
 *   - The rail groups by `section`, shows a type glyph, the effective member
 *     count, and a `← N` reverse-reference badge.
 *   - Create starts at the intent picker; presets pre-fill the same editor.
 *   - Membership is composed visually (手选 picker + 自动纳入 filter preview)
 *     or bound (single-sub / collection-scope) — never hand-typed.
 *
 * The page owns all state; child components are controlled. The only network
 * read beyond the four resource lists is `/api/v1/preview/default` for the
 * real node names (via usePreviewNodes), used by every membership preview.
 */

interface RuleLite {
  id: string;
  policy: string;
}

export default function ProxyGroupsPage() {
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [templates, setTemplates] = useState<ProxyGroupTemplate[]>([]);
  const [subs, setSubs] = useState<SubscriptionLite[]>([]);
  const [rules, setRules] = useState<RuleLite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view');
  const [createStep, setCreateStep] = useState<'pick-kind' | 'fill-form'>('pick-kind');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const { nodeNames, error: previewError, reload: reloadPreview } = usePreviewNodes();

  const reload = useCallback(async () => {
    try {
      const [gs, ts, ss, rs] = await Promise.all([
        api<{ data: ProxyGroup[] }>('/api/v1/proxy-groups'),
        api<{ data: ProxyGroupTemplate[] }>('/api/v1/proxy-group-templates'),
        api<{ data: SubscriptionLite[] }>('/api/v1/subscriptions'),
        api<{ data: RuleLite[] }>('/api/v1/rules'),
      ]);
      setGroups(gs.data);
      setTemplates(ts.data);
      setSubs(
        ss.data.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          node_prefix: s.node_prefix,
          tags: s.tags ?? [],
        })),
      );
      setRules(rs.data.map((r) => ({ id: r.id, policy: r.policy })));
      setError(null);
      setSelectedId((prev) =>
        prev && gs.data.some((g) => g.id === prev) ? prev : gs.data[0]?.id ?? null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selected = useMemo(
    () => groups.find((g) => g.id === selectedId) ?? null,
    [groups, selectedId],
  );

  const ruleRefCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rules) m.set(r.policy, (m.get(r.policy) ?? 0) + 1);
    return m;
  }, [rules]);
  const refCount = useCallback((name: string) => ruleRefCount.get(name) ?? 0, [ruleRefCount]);

  const refSummaryFor = useCallback(
    (g: ProxyGroup): RefSummary => {
      const names = new Set(groups.map((x) => x.name));
      const refIn: string[] = [];
      const refOut: string[] = [];
      for (const other of groups) {
        if (other.id === g.id) continue;
        if (other.proxies?.includes(g.name) || other['dialer-proxy'] === g.name) {
          refIn.push(other.name);
        }
      }
      for (const p of g.proxies ?? []) if (names.has(p)) refOut.push(p);
      return { rules: refCount(g.name), refIn, refOut };
    },
    [groups, refCount],
  );

  const stat = useCallback(
    (g: ProxyGroup) => memberStat(g, nodeNames, subs),
    [nodeNames, subs],
  );

  function startCreate() {
    setForm(EMPTY_FORM);
    setCreateStep('pick-kind');
    setMode('create');
    setError(null);
  }
  function pickKind(kind: ProxyGroupKind) {
    setForm({ ...EMPTY_FORM, kind, ...presetDefaults(kind) });
    setCreateStep('fill-form');
    setError(null);
  }
  function startEdit() {
    if (!selected) return;
    setForm(fromGroup(selected));
    setMode('edit');
    setError(null);
  }
  function cancel() {
    setMode('view');
    setError(null);
  }

  async function onSubmit() {
    if (!form.name.trim()) {
      setError('请填写策略组名称。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = toPayload(form);
      if (mode === 'create') {
        const res = await api<{ data: ProxyGroup }>('/api/v1/proxy-groups', {
          method: 'POST',
          body: payload,
        });
        await Promise.all([reload(), reloadPreview()]);
        setSelectedId(res.data.id);
      } else if (mode === 'edit' && selected) {
        await api(`/api/v1/proxy-groups/${selected.id}`, { method: 'PATCH', body: payload });
        await Promise.all([reload(), reloadPreview()]);
      }
      setMode('view');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!selected) return;
    if (!confirm(`确定删除策略组「${selected.name}」?被引用时会拒绝删除。`)) return;
    setBusy(true);
    try {
      await api(`/api/v1/proxy-groups/${selected.id}`, { method: 'DELETE' });
      setSelectedId(null);
      setMode('view');
      await Promise.all([reload(), reloadPreview()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="p-8"><Placeholder rows={6} /></div>;

  return (
    <div className="flex flex-col h-full">
      <header className="px-8 py-6 border-b border-[var(--color-border)]">
        <h1 className="font-serif text-[24px] tracking-[-0.015em] text-[var(--color-ink)]">
          策略组
        </h1>
        <p className="text-[13px] text-[var(--color-muted)] mt-1">
          {groups.length} 个策略组 · 成员从清单点选,不用手打字
          {previewError && ' · ⚠ 节点列表暂不可用(预览失败),仍可编辑'}
        </p>
      </header>

      <div className="flex-1 grid grid-cols-[300px_1fr] overflow-hidden">
        <LeftRail
          groups={groups}
          selectedId={selectedId}
          query={query}
          onQuery={setQuery}
          onSelect={(id) => {
            setSelectedId(id);
            setMode('view');
          }}
          onCreate={startCreate}
          stat={stat}
          refCount={refCount}
          creating={mode === 'create'}
        />

        <main className="overflow-y-auto p-8">
          {error && (
            <div className="mb-4 px-4 py-3 rounded-lg border border-[var(--color-danger)]/30 bg-[#F4D8D2] text-[var(--color-danger)] text-[13px]">
              {error}
            </div>
          )}

          {mode === 'view' && selected && (
            <GroupDetail
              group={selected}
              templates={templates}
              nodeNames={nodeNames}
              subs={subs}
              refSummary={refSummaryFor(selected)}
              busy={busy}
              onEdit={startEdit}
              onDelete={onDelete}
            />
          )}
          {mode === 'view' && !selected && (
            <p className="text-[13px] text-[var(--color-muted)]">
              {groups.length > 0 ? '从左侧选择一个策略组查看 / 编辑。' : '还没有策略组,点左上「+ 新建策略组」。'}
            </p>
          )}

          {mode === 'create' && createStep === 'pick-kind' && (
            <IntentPicker onPick={pickKind} onCancel={cancel} />
          )}

          {(mode === 'edit' || (mode === 'create' && createStep === 'fill-form')) && (
            <GroupEditor
              form={form}
              setForm={setForm}
              templates={templates}
              subs={subs}
              groups={groups}
              nodeNames={nodeNames}
              previewError={previewError}
              isCreate={mode === 'create'}
              originalName={selected?.name ?? ''}
              refSummary={mode === 'edit' && selected ? refSummaryFor(selected) : null}
              busy={busy}
              onSubmit={onSubmit}
              onCancel={cancel}
              onBackToPicker={mode === 'create' ? () => setCreateStep('pick-kind') : undefined}
            />
          )}
        </main>
      </div>
    </div>
  );
}
