'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Placeholder } from '@/components/ui/Reveal';
import { StatusDot } from '@/components/ui/StatusDot';
import { ApiError, api } from '@/lib/client/api';

interface Collection {
  id: string;
  name: string;
  subscription_ids: string[];
  subscription_tags: string[];
  dedup_by: 'name' | 'server-port' | 'none';
  name_prefix?: string;
  notes?: string;
  updated_at?: number;
}

interface Subscription {
  id: string;
  name: string;
  enabled: boolean;
  tags?: string[];
}

function dedupLabel(d: Collection['dedup_by']): string {
  switch (d) {
    case 'name':
      return '按名称去重';
    case 'server-port':
      return '按 server:port 去重';
    case 'none':
      return '不去重';
  }
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view');
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [cs, ss] = await Promise.all([
        api<{ data: Collection[] }>('/api/v1/collections'),
        api<{ data: Subscription[] }>('/api/v1/subscriptions'),
      ]);
      setCollections(cs.data);
      setSubs(ss.data);
      setError(null);
      setSelectedId((prev) => prev ?? cs.data[0]?.id ?? null);
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
    () => collections.find((c) => c.id === selectedId) ?? null,
    [collections, selectedId],
  );

  async function onDelete(id: string) {
    if (!confirm('确定删除该聚合？')) return;
    try {
      await api(`/api/v1/collections/${id}`, { method: 'DELETE' });
      const next = collections.filter((c) => c.id !== id);
      setCollections(next);
      if (selectedId === id) setSelectedId(next[0]?.id ?? null);
      setMode('view');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="-mx-8 -mt-8 -mb-12 flex flex-col h-[calc(100vh-0px)]">
      <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-baseline gap-3">
          <Link
            href="/subscriptions"
            className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors -ml-1 mr-1"
            title="返回订阅源"
          >
            ← 订阅源
          </Link>
          <h1
            className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            聚合管理
          </h1>
          <span className="text-[12px] tabular-nums text-[var(--color-muted)]">
            {collections.length} 个
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setMode('create');
            setSelectedId(null);
          }}
        >
          + 新建聚合
        </Button>
      </header>

      {error && (
        <div className="shrink-0 px-6 py-2 text-[12px] bg-[#F4D8D2]/40 text-[var(--color-danger)] border-b border-[var(--color-border)]">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[280px_1fr]">
        <nav className="border-r border-[var(--color-border)] bg-[var(--color-bg-sunk)] overflow-y-auto">
          {!loaded ? (
            <div className="px-4 py-3 space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Placeholder rows={1} className="max-w-[140px]" />
                  <Placeholder rows={1} className="max-w-[100px]" />
                </div>
              ))}
            </div>
          ) : collections.length === 0 && mode !== 'create' ? (
            <p className="px-5 py-8 text-[13px] text-[var(--color-muted)] text-center">
              还没有聚合
            </p>
          ) : (
            <ul>
              {collections.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(c.id);
                      setMode('view');
                    }}
                    className={`w-full text-left px-4 py-3 border-b border-[var(--color-border)] transition-colors active:scale-[0.99] ${
                      selectedId === c.id && mode !== 'create'
                        ? 'bg-[var(--color-surface)] border-l-[2px] border-l-[var(--color-primary)] pl-[14px]'
                        : 'hover:bg-[var(--color-surface)]/60'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-serif text-[15px] text-[var(--color-fg)] truncate flex-1"
                        style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
                      >
                        {c.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--color-muted)] font-mono">
                      <span>{dedupLabel(c.dedup_by)}</span>
                      <span>·</span>
                      <span className="tabular-nums">{c.subscription_ids.length} 订阅</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <main className="overflow-y-auto bg-[var(--color-bg)]">
          {mode === 'create' ? (
            <CollectionForm
              subs={subs}
              onCancel={() => {
                setMode('view');
                if (collections.length > 0) setSelectedId(collections[0].id);
              }}
              onSubmit={async (input) => {
                await api('/api/v1/collections', { method: 'POST', body: input });
                await reload();
                setMode('view');
              }}
            />
          ) : selected && mode === 'edit' ? (
            <CollectionForm
              subs={subs}
              initial={selected}
              onCancel={() => setMode('view')}
              onSubmit={async (input) => {
                await api(`/api/v1/collections/${selected.id}`, { method: 'PATCH', body: input });
                await reload();
                setMode('view');
              }}
            />
          ) : selected ? (
            <CollectionDetail
              collection={selected}
              subs={subs}
              onEdit={() => setMode('edit')}
              onDelete={() => onDelete(selected.id)}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-[13px] text-[var(--color-muted)]">从左侧选择一个聚合</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function CollectionDetail({
  collection,
  subs,
  onEdit,
  onDelete,
}: {
  collection: Collection;
  subs: Subscription[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const subById = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);
  const resolved = useMemo(() => {
    const ids = new Set(collection.subscription_ids);
    if (collection.subscription_tags.length > 0) {
      for (const s of subs) {
        if (s.tags?.some((t) => collection.subscription_tags.includes(t))) {
          ids.add(s.id);
        }
      }
    }
    return [...ids]
      .map((id) => subById.get(id))
      .filter((s): s is Subscription => !!s);
  }, [collection, subs, subById]);

  return (
    <article className="max-w-3xl mx-auto px-8 py-8 space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2
            className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)] truncate"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            {collection.name}
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-muted)] font-mono">
            {dedupLabel(collection.dedup_by)}
            {collection.name_prefix && ` · 前缀 ${collection.name_prefix}`}
            {' · '}{resolved.length} 个成员
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            编辑
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete}>
            删除
          </Button>
        </div>
      </header>

      {collection.notes && (
        <section>
          <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-2">
            备注
          </h3>
          <p className="text-[14px] leading-[1.6] text-[var(--color-fg)]">{collection.notes}</p>
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            已选订阅
          </h3>
          <span className="text-[11px] font-mono text-[var(--color-muted)] tabular-nums">
            {resolved.length}
          </span>
        </div>
        {resolved.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)] italic">无成员</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            {resolved.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-bg-sunk)] transition-colors"
              >
                <StatusDot tone={s.enabled ? 'on' : 'off'} />
                <span className="font-mono text-[13px] text-[var(--color-fg)] flex-1">
                  {s.name}
                </span>
                {!s.enabled && (
                  <span className="text-[11px] text-[var(--color-warn)]">⚠ 已停用</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {collection.subscription_tags.length > 0 && (
        <section>
          <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-2">
            按标签匹配
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {collection.subscription_tags.map((t) => (
              <Badge key={t} tone="neutral">
                {t}
              </Badge>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

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
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.subscription_ids ?? []),
  );
  const [tagsInput, setTagsInput] = useState(initial?.subscription_tags?.join(', ') ?? '');
  const [dedupBy, setDedupBy] = useState<'name' | 'server-port' | 'none'>(
    initial?.dedup_by ?? 'name',
  );
  const [namePrefix, setNamePrefix] = useState(initial?.name_prefix ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;
    setPending(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      await onSubmit({
        name: name.trim(),
        subscription_ids: [...selected],
        subscription_tags: tags,
        dedup_by: dedupBy,
        name_prefix: namePrefix.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-3xl mx-auto px-8 py-8 space-y-5">
      <header>
        <h2
          className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
        >
          {initial ? `编辑「${initial.name}」` : '新建聚合'}
        </h2>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FormField label="名称 (slug)">
          <Input
            placeholder="main-pool"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z0-9-]+"
            disabled={!!initial}
            required
          />
        </FormField>
        <FormField label="去重方式">
          <Select
            value={dedupBy}
            onChange={(e) => setDedupBy(e.target.value as 'name' | 'server-port' | 'none')}
          >
            <option value="name">按名称去重</option>
            <option value="server-port">按 server:port 去重</option>
            <option value="none">不去重</option>
          </Select>
        </FormField>
        <FormField label="名称前缀">
          <Input
            placeholder="可选，如 [主]"
            value={namePrefix}
            onChange={(e) => setNamePrefix(e.target.value)}
          />
        </FormField>
      </div>

      <FormField label="手动勾选订阅">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-sunk)] p-2 max-h-56 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-1">
          {subs.length === 0 ? (
            <p className="text-[12px] text-[var(--color-muted)] px-2 py-1">
              还没有订阅源，请先到「订阅源」页新增。
            </p>
          ) : (
            subs.map((s) => {
              const checked = selected.has(s.id);
              return (
                <label
                  key={s.id}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer text-[12px] transition-colors ${
                    checked
                      ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]'
                      : 'hover:bg-[var(--color-surface)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(s.id)}
                    className="accent-[var(--color-primary)] w-3.5 h-3.5"
                  />
                  <StatusDot tone={s.enabled ? 'on' : 'off'} />
                  <span className="font-mono truncate flex-1">{s.name}</span>
                </label>
              );
            })
          )}
        </div>
      </FormField>

      <FormField label="标签匹配 — 命中任一标签的订阅自动加入">
        <Input
          placeholder="premium, asia"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
      </FormField>

      <FormField label="备注">
        <Input
          placeholder="可选"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </FormField>

      {error && (
        <p className="text-[12px] text-[var(--color-danger)] bg-[#F4D8D2]/40 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !name}>
          {pending ? '…' : initial ? '保存' : '创建'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function FormField({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}
