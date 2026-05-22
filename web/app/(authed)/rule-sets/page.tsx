'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { InlineUrl } from '@/components/ui/InlineUrl';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Placeholder } from '@/components/ui/Reveal';
import { ShikiBlock } from '@/components/ui/ShikiBlock';
import { StatusDot } from '@/components/ui/StatusDot';
import { ApiError, api } from '@/lib/client/api';

type Format = 'yaml' | 'text';
type Behavior = 'classical' | 'domain' | 'ipcidr';

interface RuleSet {
  id: string;
  name: string;
  format: Format;
  behavior?: Behavior;
  content: string;
  note?: string;
  updated_at: number;
}

interface Meta {
  ruleProvidersBase: string;
}

function fmtTime(s: number): string {
  return new Date(s * 1000).toLocaleString('zh-CN');
}

function timeAgo(s: number): string {
  const diff = Date.now() / 1000 - s;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} 天前`;
  return new Date(s * 1000).toLocaleDateString('zh-CN');
}

export default function RuleSetsPage() {
  const [sets, setSets] = useState<RuleSet[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view');
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, m] = await Promise.all([
        api<{ data: RuleSet[] }>('/api/v1/rule-sets'),
        api<{ data: Meta }>('/api/v1/meta'),
      ]);
      setSets(list.data);
      setMeta(m.data);
      if (!selectedId && list.data.length > 0) setSelectedId(list.data[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [selectedId]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => sets.find((s) => s.id === selectedId) ?? null,
    [sets, selectedId],
  );

  async function onDelete(id: string) {
    if (!confirm('确定删除该规则集？')) return;
    try {
      await api(`/api/v1/rule-sets/${id}`, { method: 'DELETE' });
      const next = sets.filter((s) => s.id !== id);
      setSets(next);
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
          <h1
            className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            规则集
          </h1>
          <span className="text-[12px] tabular-nums text-[var(--color-muted)]">
            {sets.length} 个
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setMode('create');
            setSelectedId(null);
          }}
        >
          + 新增
        </Button>
      </header>

      {error && (
        <div className="shrink-0 px-6 py-2 text-[12px] bg-[#F4D8D2]/40 text-[var(--color-danger)] border-b border-[var(--color-border)]">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[280px_1fr]">
        {/* Master: list */}
        <nav className="border-r border-[var(--color-border)] bg-[var(--color-bg-sunk)] overflow-y-auto">
          {!loaded ? (
            <div className="px-4 py-3 space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Placeholder rows={1} className="max-w-[140px]" />
                  <Placeholder rows={1} className="max-w-[100px]" />
                </div>
              ))}
            </div>
          ) : sets.length === 0 ? (
            <p className="px-5 py-8 text-[13px] text-[var(--color-muted)] text-center">
              还没有规则集
            </p>
          ) : (
            <ul>
              {sets.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(s.id);
                      setMode('view');
                    }}
                    className={`w-full text-left px-4 py-3 border-b border-[var(--color-border)] transition-colors active:scale-[0.99] ${
                      selectedId === s.id
                        ? 'bg-[var(--color-surface)] border-l-[2px] border-l-[var(--color-primary)] pl-[14px]'
                        : 'hover:bg-[var(--color-surface)]/60'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot tone="on" />
                      <span className="font-mono text-[13px] text-[var(--color-fg)] truncate flex-1">
                        {s.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--color-muted)]">
                      <span className="font-mono">{s.format}</span>
                      <span>·</span>
                      <span className="tabular-nums">{s.content.split('\n').length} 行</span>
                      <span className="ml-auto">{timeAgo(s.updated_at)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        {/* Detail */}
        <main className="overflow-y-auto bg-[var(--color-bg)]">
          {mode === 'create' ? (
            <CreateForm
              onCancel={() => {
                setMode('view');
                if (sets.length > 0) setSelectedId(sets[0].id);
              }}
              onCreated={async () => {
                await reload();
                setMode('view');
              }}
            />
          ) : selected ? (
            mode === 'edit' ? (
              <EditForm
                set={selected}
                onCancel={() => setMode('view')}
                onSaved={async () => {
                  await reload();
                  setMode('view');
                }}
              />
            ) : (
              <Detail
                set={selected}
                providerUrl={meta ? `${meta.ruleProvidersBase}/${selected.name}` : ''}
                onEdit={() => setMode('edit')}
                onDelete={() => onDelete(selected.id)}
              />
            )
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-[13px] text-[var(--color-muted)]">从左侧选择一个规则集</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Detail({
  set,
  providerUrl,
  onEdit,
  onDelete,
}: {
  set: RuleSet;
  providerUrl: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="max-w-3xl mx-auto px-8 py-8 space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2
            className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)] truncate"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            {set.name}
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-muted)] font-mono">
            {set.format} {set.behavior && `· behavior=${set.behavior}`} · {set.content.split('\n').length} 行 · 更新于 {fmtTime(set.updated_at)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            编辑
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete}>
            删除
          </Button>
        </div>
      </header>

      <section>
        <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-2">
          Provider URL
        </h3>
        <InlineUrl value={providerUrl} />
      </section>

      {set.note && (
        <section>
          <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-2">
            备注
          </h3>
          <p className="text-[14px] text-[var(--color-fg)] leading-[1.6]">{set.note}</p>
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            内容预览
          </h3>
          <span className="text-[11px] font-mono text-[var(--color-muted)] tabular-nums">
            {set.format}
          </span>
        </div>
        <ShikiBlock
          code={set.content}
          lang={set.format === 'yaml' ? 'yaml' : 'bash'}
          maxHeight="60vh"
        />
      </section>
    </article>
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

function CreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [format, setFormat] = useState<Format>('yaml');
  const [behavior, setBehavior] = useState<Behavior | ''>('classical');
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api('/api/v1/rule-sets', {
        method: 'POST',
        body: {
          name: name.trim(),
          format,
          behavior: behavior || undefined,
          content,
          note: note.trim() || undefined,
        },
      });
      await onCreated();
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
          新增规则集
        </h2>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FormField label="名称 (slug)">
          <Input
            placeholder="emby_classic"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z0-9_-]+"
            required
          />
        </FormField>
        <FormField label="格式">
          <Select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="yaml">yaml</option>
            <option value="text">text</option>
          </Select>
        </FormField>
        <FormField label="behavior">
          <Select
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as Behavior | '')}
          >
            <option value="">（无）</option>
            <option value="classical">classical</option>
            <option value="domain">domain</option>
            <option value="ipcidr">ipcidr</option>
          </Select>
        </FormField>
      </div>

      <FormField label="备注（可选）">
        <Input placeholder="一句话描述用途" value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>

      <FormField label="内容">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          spellCheck={false}
          placeholder={'payload:\n  - DOMAIN-SUFFIX,emby.media\n  - DOMAIN-KEYWORD,emby\n'}
          className="text-[12px]"
          required
        />
      </FormField>

      {error && (
        <p className="text-[12px] text-[var(--color-danger)] bg-[#F4D8D2]/40 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? '创建中…' : '创建'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function EditForm({
  set,
  onCancel,
  onSaved,
}: {
  set: RuleSet;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(set.content);
  const [note, setNote] = useState(set.note ?? '');
  const [behavior, setBehavior] = useState<Behavior | ''>(set.behavior ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api(`/api/v1/rule-sets/${set.id}`, {
        method: 'PATCH',
        body: {
          content: draft,
          note: note.trim() || undefined,
          behavior: behavior || undefined,
        },
      });
      await onSaved();
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
          编辑 <code className="font-mono">{set.name}</code>
        </h2>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="behavior">
          <Select
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as Behavior | '')}
          >
            <option value="">（无）</option>
            <option value="classical">classical</option>
            <option value="domain">domain</option>
            <option value="ipcidr">ipcidr</option>
          </Select>
        </FormField>
        <FormField label="备注">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>

      <FormField label="内容">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={20}
          spellCheck={false}
          className="text-[12px]"
        />
      </FormField>

      {error && (
        <p className="text-[12px] text-[var(--color-danger)] bg-[#F4D8D2]/40 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? '保存中…' : '保存'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
