'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { InlineUrl } from '@/components/ui/InlineUrl';
import { Input, Select } from '@/components/ui/Input';
import { Placeholder } from '@/components/ui/Reveal';
import { StatusDot } from '@/components/ui/StatusDot';
import { YamlEditor } from '@/components/ui/YamlEditor';
import { ApiError, api } from '@/lib/client/api';

type Format = 'yaml' | 'text' | 'mrs';
type Behavior = 'classical' | 'domain' | 'ipcidr';
type Source = 'local' | 'remote';
type Filter = 'all' | 'local' | 'remote';

interface RuleSet {
  id: string;
  name: string;
  source?: Source;
  format: Format;
  behavior?: Behavior;
  content: string;
  url?: string;
  interval?: number;
  proxy?: string;
  note?: string;
  updated_at: number;
}

interface Meta {
  ruleProvidersBase: string;
}

const sourceOf = (s: RuleSet): Source => s.source ?? 'local';

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
function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ─── small presentational helpers ──────────────────────────────────── */

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'local' | 'remote' }) {
  const cls =
    tone === 'local'
      ? 'bg-[#E6EEDD] text-[var(--color-success)]'
      : tone === 'remote'
        ? 'bg-[var(--color-bg-strong)] text-[var(--color-plum)]'
        : 'bg-[var(--color-bg-strong)] text-[var(--color-fg-soft)]';
  return (
    <span className={`inline-flex items-center h-[18px] px-1.5 rounded text-[10px] font-mono ${cls}`}>
      {children}
    </span>
  );
}

function FormField({ label, hint, children }: { label: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

function intervalToNum(s: string): number | undefined {
  const n = Number(s.trim());
  return s.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
}

/* ─── page ──────────────────────────────────────────────────────────── */

export default function RuleSetsPage() {
  const [sets, setSets] = useState<RuleSet[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async (selectName?: string) => {
    setError(null);
    try {
      const [list, m, rules] = await Promise.all([
        api<{ data: RuleSet[] }>('/api/v1/rule-sets'),
        api<{ data: Meta }>('/api/v1/meta'),
        api<{ data: { type: string; value: string }[] }>('/api/v1/rules?limit=500').catch(() => ({
          data: [] as { type: string; value: string }[],
        })),
      ]);
      setSets(list.data);
      setMeta(m.data);
      const counts: Record<string, number> = {};
      for (const r of rules.data) {
        if (r.type === 'RULE-SET' && r.value) counts[r.value] = (counts[r.value] ?? 0) + 1;
      }
      setUsage(counts);
      setSelectedId((prev) => {
        if (selectName) return list.data.find((s) => s.name === selectName)?.id ?? prev;
        if (prev && list.data.some((s) => s.id === prev)) return prev;
        return list.data[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selected = useMemo(() => sets.find((s) => s.id === selectedId) ?? null, [sets, selectedId]);

  const { local, remote } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: RuleSet) =>
      !q || s.name.toLowerCase().includes(q) || (s.url ?? '').toLowerCase().includes(q) || (s.note ?? '').toLowerCase().includes(q);
    return {
      local: sets.filter((s) => sourceOf(s) === 'local' && match(s)),
      remote: sets.filter((s) => sourceOf(s) === 'remote' && match(s)),
    };
  }, [sets, query]);

  async function onDelete(id: string) {
    if (!confirm('确定删除该规则集？')) return;
    try {
      await api(`/api/v1/rule-sets/${id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    }
  }

  const counts = { local: local.length, remote: remote.length };

  return (
    <div className="-mx-8 -mt-8 -mb-12 flex flex-col h-[calc(100vh-0px)]">
      {/* header */}
      <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-6 pt-3 pb-2 flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h1
              className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
            >
              规则集
            </h1>
            <span className="text-[12px] tabular-nums text-[var(--color-muted)] font-mono">
              本地 {counts.local} · 外部 {counts.remote}
            </span>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          >
            + 新增
          </Button>
        </div>
        <div className="px-6 pb-3 flex items-center gap-2">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: '全部' },
              { value: 'local', label: `本地 ${counts.local}` },
              { value: 'remote', label: `外部 ${counts.remote}` },
            ]}
          />
          <div className="flex-1 max-w-[260px]">
            <Input
              placeholder="搜索名称 / URL / 备注…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 text-[12px]"
            />
          </div>
        </div>
      </header>

      {error && (
        <div className="shrink-0 px-6 py-2 text-[12px] bg-[#F4D8D2]/40 text-[var(--color-danger)] border-b border-[var(--color-border)] flex items-center justify-between gap-3">
          <span className="min-w-0">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[280px_1fr]">
        {/* master: grouped rail */}
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
          ) : (
            <>
              {filter !== 'remote' && (
                <RailGroup
                  title="本地托管"
                  hint="平台分发，可在此维护"
                  items={local}
                  usage={usage}
                  selectedId={selectedId}
                  onSelect={(id) => {
                    setSelectedId(id);
                    setCreating(false);
                  }}
                />
              )}
              {filter !== 'local' && (
                <RailGroup
                  title="外部"
                  hint="mihomo 直接抓取"
                  items={remote}
                  usage={usage}
                  selectedId={selectedId}
                  onSelect={(id) => {
                    setSelectedId(id);
                    setCreating(false);
                  }}
                />
              )}
              {local.length === 0 && remote.length === 0 && (
                <p className="px-5 py-8 text-[13px] text-[var(--color-muted)] text-center">没有匹配的规则集</p>
              )}
            </>
          )}
        </nav>

        {/* detail */}
        <main className="min-h-0 overflow-hidden bg-[var(--color-bg)] flex flex-col">
          {creating ? (
            <CreateForm
              onCancel={() => {
                setCreating(false);
                if (sets.length > 0) setSelectedId(sets[0].id);
              }}
              onCreated={async (name) => {
                setCreating(false);
                await reload(name);
              }}
            />
          ) : selected ? (
            sourceOf(selected) === 'local' ? (
              <LocalDetail
                key={selected.id}
                set={selected}
                usedBy={usage[selected.name] ?? 0}
                providerUrl={meta ? `${meta.ruleProvidersBase}/${selected.name}` : ''}
                onSaved={() => reload(selected.name)}
                onDelete={() => onDelete(selected.id)}
                onError={setError}
              />
            ) : (
              <RemoteDetail
                key={selected.id}
                set={selected}
                usedBy={usage[selected.name] ?? 0}
                onSaved={(name) => reload(name)}
                onDelete={() => onDelete(selected.id)}
                onError={setError}
              />
            )
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-[13px] text-[var(--color-muted)]">从左侧选择一个规则集，或点「+ 新增」</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ─── segmented filter ──────────────────────────────────────────────── */

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg bg-[var(--color-bg-sunk)] border border-[var(--color-border)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-7 px-3 text-[12px] rounded-[6px] transition-colors ${
            value === o.value
              ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-sm font-medium'
              : 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ─── rail group ────────────────────────────────────────────────────── */

function RailGroup({
  title,
  hint,
  items,
  usage,
  selectedId,
  onSelect,
}: {
  title: string;
  hint: string;
  items: RuleSet[];
  usage: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section>
      <div className="sticky top-0 z-[1] px-4 py-1.5 bg-[var(--color-bg-strong)] border-y border-[var(--color-border)] flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-soft)]">
          {title}
        </span>
        <span className="text-[11px] tabular-nums text-[var(--color-muted)] font-mono">{items.length}</span>
        <span className="ml-auto text-[10px] text-[var(--color-muted)]">{hint}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-4 text-[12px] text-[var(--color-muted)]">（空）</p>
      ) : (
        <ul>
          {items.map((s) => {
            const used = usage[s.name] ?? 0;
            const remote = sourceOf(s) === 'remote';
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className={`w-full text-left px-4 py-2.5 border-b border-[var(--color-border)] transition-colors active:scale-[0.99] ${
                    selectedId === s.id
                      ? 'bg-[var(--color-surface)] border-l-[2px] border-l-[var(--color-primary)] pl-[14px]'
                      : 'hover:bg-[var(--color-surface)]/60'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusDot tone={used > 0 ? 'on' : 'off'} />
                    <span className="shrink-0 text-[var(--color-muted)] text-[11px] w-3 text-center">
                      {remote ? '↗' : '⌂'}
                    </span>
                    <span className="font-mono text-[13px] text-[var(--color-fg)] truncate flex-1">{s.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 pl-[20px] text-[11px] text-[var(--color-muted)]">
                    <span className="font-mono">{s.format}</span>
                    {s.behavior && (
                      <>
                        <span>·</span>
                        <span className="font-mono">{s.behavior}</span>
                      </>
                    )}
                    <span className="ml-auto">{used > 0 ? `被 ${used} 引用` : '未引用'}</span>
                  </div>
                  {remote && (
                    <div className="mt-0.5 pl-[20px] text-[10px] text-[var(--color-muted)] truncate font-mono">
                      {hostOf(s.url)}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ─── usage banner (shared) ─────────────────────────────────────────── */

function UsageNote({ usedBy }: { usedBy: number }) {
  return usedBy > 0 ? (
    <span className="text-[12px] text-[var(--color-fg-soft)]">
      被 <strong className="tabular-nums">{usedBy}</strong> 条 RULE-SET 规则引用 · 已注入 rule-providers
    </span>
  ) : (
    <span className="text-[12px] text-[var(--color-muted)]">未被规则引用 · 留库不下发（到「规则」页加 RULE-SET 规则启用）</span>
  );
}

/* ─── local detail: always-on editor + dirty save bar ───────────────── */

function LocalDetail({
  set,
  usedBy,
  providerUrl,
  onSaved,
  onDelete,
  onError,
}: {
  set: RuleSet;
  usedBy: number;
  providerUrl: string;
  onSaved: () => Promise<void> | void;
  onDelete: () => void;
  onError: (m: string) => void;
}) {
  const [content, setContent] = useState(set.content);
  const [format, setFormat] = useState<Exclude<Format, 'mrs'>>(set.format === 'mrs' ? 'yaml' : set.format);
  const [behavior, setBehavior] = useState<Behavior | ''>(set.behavior ?? '');
  const [interval, setIntervalStr] = useState(set.interval ? String(set.interval) : '');
  const [proxy, setProxy] = useState(set.proxy ?? '');
  const [note, setNote] = useState(set.note ?? '');
  const [saving, setSaving] = useState(false);

  const dirty =
    content !== set.content ||
    format !== set.format ||
    (behavior || undefined) !== set.behavior ||
    intervalToNum(interval) !== set.interval ||
    (proxy.trim() || undefined) !== set.proxy ||
    (note.trim() || undefined) !== set.note;

  function reset() {
    setContent(set.content);
    setFormat(set.format === 'mrs' ? 'yaml' : set.format);
    setBehavior(set.behavior ?? '');
    setIntervalStr(set.interval ? String(set.interval) : '');
    setProxy(set.proxy ?? '');
    setNote(set.note ?? '');
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api(`/api/v1/rule-sets/${set.id}`, {
        method: 'PATCH',
        body: {
          source: 'local',
          content,
          format,
          behavior: behavior || undefined,
          interval: intervalToNum(interval),
          proxy: proxy.trim() || undefined,
          note: note.trim() || undefined,
        },
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-8 pt-6 pb-3 space-y-3 border-b border-[var(--color-border)]">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2
                className="font-serif text-[24px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)] truncate"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
              >
                {set.name}
              </h2>
              <Chip tone="local">本地托管</Chip>
            </div>
            <p className="mt-1">
              <UsageNote usedBy={usedBy} />
              <span className="text-[12px] text-[var(--color-muted)]"> · 更新于 {timeAgo(set.updated_at)}</span>
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={onDelete}>
            删除
          </Button>
        </div>

        <div>
          <span className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-muted)] mr-2">Provider URL</span>
          <InlineUrl value={providerUrl} />
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-muted)]">格式</span>
            <Select value={format} onChange={(e) => setFormat(e.target.value as 'yaml' | 'text')} className="h-8 text-[12px] w-[90px]">
              <option value="yaml">yaml</option>
              <option value="text">text</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-muted)]">behavior</span>
            <Select value={behavior} onChange={(e) => setBehavior(e.target.value as Behavior | '')} className="h-8 text-[12px] w-[120px]">
              <option value="">（无）</option>
              <option value="classical">classical</option>
              <option value="domain">domain</option>
              <option value="ipcidr">ipcidr</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-muted)]">刷新(秒)</span>
            <Input value={interval} onChange={(e) => setIntervalStr(e.target.value)} placeholder="86400" className="h-8 text-[12px] w-[100px]" />
          </label>
          <label className="flex flex-col gap-1 flex-1 min-w-[140px]">
            <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-muted)]">备注</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-8 text-[12px]" />
          </label>
        </div>
      </div>

      {/* always-on editor */}
      <div className="flex-1 min-h-0">
        <YamlEditor value={content} onChange={setContent} onSave={save} />
      </div>

      {/* dirty save bar */}
      {dirty && (
        <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 border-t border-[var(--color-border)] bg-[var(--color-primary-tint)]">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-primary-hover)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)]" />
            未保存的改动
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
              放弃
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? '保存中…' : '保存 ⌘S'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── remote detail ─────────────────────────────────────────────────── */

function RemoteDetail({
  set,
  usedBy,
  onSaved,
  onDelete,
  onError,
}: {
  set: RuleSet;
  usedBy: number;
  onSaved: (name?: string) => Promise<void> | void;
  onDelete: () => void;
  onError: (m: string) => void;
}) {
  const [url, setUrl] = useState(set.url ?? '');
  const [format, setFormat] = useState<Format>(set.format);
  const [behavior, setBehavior] = useState<Behavior | ''>(set.behavior ?? '');
  const [interval, setIntervalStr] = useState(set.interval ? String(set.interval) : '');
  const [proxy, setProxy] = useState(set.proxy ?? '');
  const [note, setNote] = useState(set.note ?? '');
  const [saving, setSaving] = useState(false);
  const [localizing, setLocalizing] = useState(false);

  const dirty =
    url.trim() !== (set.url ?? '') ||
    format !== set.format ||
    (behavior || undefined) !== set.behavior ||
    intervalToNum(interval) !== set.interval ||
    (proxy.trim() || undefined) !== set.proxy ||
    (note.trim() || undefined) !== set.note;

  async function save() {
    setSaving(true);
    try {
      await api(`/api/v1/rule-sets/${set.id}`, {
        method: 'PATCH',
        body: {
          source: 'remote',
          url: url.trim(),
          format,
          behavior: behavior || undefined,
          interval: intervalToNum(interval),
          proxy: proxy.trim() || undefined,
          note: note.trim() || undefined,
        },
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function localize() {
    if (!confirm(`抓取 ${hostOf(set.url)} 的当前内容并转为本平台托管？之后由你在平台内维护。`)) return;
    setLocalizing(true);
    try {
      const res = await api<{ meta: { bytes: number } }>(`/api/v1/rule-sets/${set.id}/localize`, {
        method: 'POST',
      });
      await onSaved(set.name);
      void res;
    } catch (err) {
      onError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setLocalizing(false);
    }
  }

  const canLocalize = set.format !== 'mrs';

  return (
    <div className="overflow-y-auto">
      <article className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <header className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2
                className="font-serif text-[26px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)] truncate"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
              >
                {set.name}
              </h2>
              <Chip tone="remote">外部</Chip>
            </div>
            <p className="mt-1">
              <UsageNote usedBy={usedBy} />
              <span className="text-[12px] text-[var(--color-muted)]"> · 更新于 {fmtTime(set.updated_at)}</span>
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={onDelete}>
            删除
          </Button>
        </header>

        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
              转为本平台托管
            </h3>
            <Button
              variant="secondary"
              size="sm"
              onClick={localize}
              disabled={!canLocalize || localizing}
              title={canLocalize ? '' : 'mrs 二进制无法转为本地文本托管'}
            >
              {localizing ? '抓取中…' : '转为本地托管'}
            </Button>
          </div>
          <p className="text-[12px] text-[var(--color-muted)] leading-[1.6]">
            {canLocalize
              ? '抓取该 URL 的当前内容，存为本地规则集，之后由本平台分发、你可直接在平台内维护。'
              : 'mrs 为二进制格式，无法转为本地文本托管；如需自维护可改用 yaml/text 的源。'}
          </p>
        </section>

        <FormField label="外部 URL" hint="mihomo 直接抓取，平台不存内容">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-[12px]" />
          {set.url && (
            <div className="mt-1.5">
              <InlineUrl value={set.url} />
            </div>
          )}
        </FormField>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField label="格式">
            <Select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
              <option value="yaml">yaml</option>
              <option value="text">text</option>
              <option value="mrs">mrs</option>
            </Select>
          </FormField>
          <FormField label="behavior">
            <Select value={behavior} onChange={(e) => setBehavior(e.target.value as Behavior | '')}>
              <option value="">（无）</option>
              <option value="classical">classical</option>
              <option value="domain">domain</option>
              <option value="ipcidr">ipcidr</option>
            </Select>
          </FormField>
          <FormField label="刷新间隔（秒）">
            <Input value={interval} onChange={(e) => setIntervalStr(e.target.value)} placeholder="86400" />
          </FormField>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="下载代理 / 策略（可选）">
            <Input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="如 DIRECT 或某策略组" />
          </FormField>
          <FormField label="备注">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? '保存中…' : '保存改动'}
          </Button>
          {dirty && <span className="text-[12px] text-[var(--color-muted)]">有未保存的改动</span>}
        </div>
      </article>
    </div>
  );
}

/* ─── create (source-first) ─────────────────────────────────────────── */

function CreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (name: string) => Promise<void> | void;
}) {
  const [source, setSource] = useState<Source>('local');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<Format>('yaml');
  const [behavior, setBehavior] = useState<Behavior | ''>('classical');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [interval, setIntervalStr] = useState('');
  const [proxy, setProxy] = useState('');
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
          source,
          format,
          behavior: behavior || undefined,
          interval: intervalToNum(interval),
          proxy: proxy.trim() || undefined,
          note: note.trim() || undefined,
          ...(source === 'remote' ? { url: url.trim(), content: '' } : { content }),
        },
      });
      await onCreated(name.trim());
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="overflow-y-auto">
      <form onSubmit={submit} className="max-w-3xl mx-auto px-8 py-8 space-y-5">
        <header>
          <h2
            className="font-serif text-[26px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            新增规则集
          </h2>
        </header>

        <FormField label="来源">
          <Segmented
            value={source}
            onChange={(v) => {
              setSource(v);
              if (v === 'local' && format === 'mrs') setFormat('yaml');
            }}
            options={[
              { value: 'local', label: '本地托管（平台分发，可编辑）' },
              { value: 'remote', label: '外部 URL（mihomo 抓取）' },
            ]}
          />
        </FormField>

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
              {source === 'remote' && <option value="mrs">mrs</option>}
            </Select>
          </FormField>
          <FormField label="behavior">
            <Select value={behavior} onChange={(e) => setBehavior(e.target.value as Behavior | '')}>
              <option value="">（无）</option>
              <option value="classical">classical</option>
              <option value="domain">domain</option>
              <option value="ipcidr">ipcidr</option>
            </Select>
          </FormField>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="刷新间隔（秒，可选）">
            <Input value={interval} onChange={(e) => setIntervalStr(e.target.value)} placeholder="86400" />
          </FormField>
          <FormField label="下载代理 / 策略（可选）">
            <Input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="如 DIRECT" />
          </FormField>
        </div>

        <FormField label="备注（可选）">
          <Input placeholder="一句话描述用途" value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>

        {source === 'remote' ? (
          <FormField label="外部 URL">
            <Input placeholder="https://example.com/rules.mrs" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </FormField>
        ) : (
          <FormField label="内容">
            <div className="h-[360px] rounded-lg border border-[var(--color-border)] overflow-hidden">
              <YamlEditor value={content} onChange={setContent} />
            </div>
          </FormField>
        )}

        {error && (
          <p className="text-[12px] text-[var(--color-danger)] bg-[#F4D8D2]/40 rounded-md px-3 py-2">{error}</p>
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
    </div>
  );
}
