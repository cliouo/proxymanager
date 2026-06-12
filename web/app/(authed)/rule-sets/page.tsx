'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { ApiError, api } from '@/lib/client/api';
import styles from './ruleSets.module.css';

type Format = 'yaml' | 'text' | 'mrs';
type Behavior = 'classical' | 'domain' | 'ipcidr';
type Source = 'local' | 'remote';

interface RuleSet {
  id: string;
  name: string;
  source?: Source;
  format: Format;
  behavior?: Behavior;
  /** 列表接口不再返回 content——只有 GET /rule-sets/{id} 详情带。 */
  content?: string;
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
function intervalToNum(s: string): number | undefined {
  const n = Number(s.trim());
  return s.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
}

export default function RuleSetsPage() {
  const [sets, setSets] = useState<RuleSet[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [chips, setChips] = useState<Set<Source>>(new Set());
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
  const usedCount = useMemo(() => sets.filter((s) => (usage[s.name] ?? 0) > 0).length, [sets, usage]);

  // 列表只回 meta；本地托管的编辑器需要 content——选中时按 id 拉详情。
  // `selected` 在每次 reload 后是新对象,保存成功后这里会自动重拉到最新内容。
  const [detail, setDetail] = useState<RuleSet | null>(null);
  useEffect(() => {
    if (!selected || sourceOf(selected) !== 'local') {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail((prev) => (prev && prev.id === selected.id ? prev : null));
    api<{ data: RuleSet }>(`/api/v1/rule-sets/${selected.id}`)
      .then((res) => {
        if (!cancelled) setDetail(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sets.filter((s) => {
      const okQ =
        !q ||
        s.name.toLowerCase().includes(q) ||
        (s.url ?? '').toLowerCase().includes(q) ||
        (s.note ?? '').toLowerCase().includes(q);
      const okChip = chips.size === 0 || chips.has(sourceOf(s));
      return okQ && okChip;
    });
  }, [sets, query, chips]);

  function toggleChip(c: Source) {
    setChips((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  }

  async function onDelete(id: string) {
    if (!confirm('确定删除该规则集？')) return;
    try {
      await api(`/api/v1/rule-sets/${id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    }
  }

  return (
    <>
      <PageTopbar contentMaxWidth={1320}>
        <h1>规则集</h1>
        <ScopePill shared />
        {loaded && (
          <span className="crumb">
            {sets.length} 个 · {usedCount} 被引用
          </span>
        )}
        <div className="grow" />
        <button
          className="btn primary"
          onClick={() => {
            setCreating(true);
            setSelectedId(null);
          }}
        >
          ＋ 新建规则集
        </button>
      </PageTopbar>

      {error && (
        <div
          className="panel"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)',
            background: 'var(--danger-dim)',
            color: 'var(--danger)',
            padding: '11px 14px',
            fontSize: 13,
            marginBottom: 16,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span style={{ minWidth: 0 }}>{error}</span>
          <button onClick={() => setError(null)} style={{ color: 'inherit', opacity: 0.7 }}>
            ✕
          </button>
        </div>
      )}

      <div className="md-grid">
        <aside>
          <div className="search" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="搜索规则集…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {(['local', 'remote'] as Source[]).map((c) => (
              <button
                key={c}
                className={`chip${chips.has(c) ? ' on' : ''}`}
                onClick={() => toggleChip(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="md-list">
            {!loaded ? (
              <div className="pm-pulse" style={{ color: 'var(--faint)', fontSize: 12, padding: 8 }}>
                加载中 …
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13, padding: 8 }}>没有匹配的规则集</div>
            ) : (
              filtered.map((s) => {
                const used = usage[s.name] ?? 0;
                return (
                  <button
                    key={s.id}
                    className={`li${s.id === selectedId && !creating ? ' on' : ''}`}
                    onClick={() => {
                      setSelectedId(s.id);
                      setCreating(false);
                    }}
                  >
                    <b>
                      {s.name}
                      <span
                        className={`pill ${used > 0 ? 'ai' : 'warn'} plain`}
                        style={{ marginLeft: 'auto' }}
                      >
                        {used > 0 ? `被 ${used} 引用` : '未被使用'}
                      </span>
                    </b>
                    <span>
                      {sourceOf(s)} · {s.format}
                      {s.behavior ? ` · ${s.behavior}` : ''} · {timeAgo(s.updated_at)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section>
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
              detail && detail.id === selected.id ? (
                <LocalDetail
                  key={selected.id}
                  set={detail}
                  usedBy={usage[selected.name] ?? 0}
                  providerUrl={meta ? `${meta.ruleProvidersBase}/${selected.name}` : ''}
                  onSaved={() => reload(selected.name)}
                  onDelete={() => onDelete(selected.id)}
                  onError={setError}
                />
              ) : (
                <div
                  className="panel pm-pulse"
                  style={{ padding: '56px 24px', textAlign: 'center', color: 'var(--faint)', fontSize: 13 }}
                >
                  加载内容 …
                </div>
              )
            ) : (
              <RemoteDetail
                key={selected.id}
                set={selected}
                usedBy={usage[selected.name] ?? 0}
                onSaved={() => reload(selected.name)}
                onDelete={() => onDelete(selected.id)}
                onError={setError}
              />
            )
          ) : (
            <div
              className="panel"
              style={{ padding: '56px 24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}
            >
              从左侧选择一个规则集，或点「＋ 新建规则集」
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/* ─── local detail ──────────────────────────────────────────────────── */

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
  const [content, setContent] = useState(set.content ?? '');
  const [format, setFormat] = useState<Exclude<Format, 'mrs'>>(
    set.format === 'mrs' ? 'yaml' : set.format,
  );
  const [behavior, setBehavior] = useState<Behavior | ''>(set.behavior ?? '');
  const [interval, setIntervalStr] = useState(set.interval ? String(set.interval) : '');
  const [note, setNote] = useState(set.note ?? '');
  const [saving, setSaving] = useState(false);

  const dirty =
    content !== (set.content ?? '') ||
    format !== set.format ||
    (behavior || undefined) !== set.behavior ||
    intervalToNum(interval) !== set.interval ||
    (note.trim() || undefined) !== set.note;

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
    <section className="panel">
      <div className="panel-head">
        <h2 className="mono" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {set.name}
        </h2>
        <span className="pill idle plain">local</span>
        <div className="grow" />
        <button className="btn primary sm" onClick={save} disabled={!dirty || saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button className="btn sm danger" onClick={onDelete}>
          删除
        </button>
      </div>
      <div className="panel-body">
        <div className={styles.metaGrid}>
          <div className="cell">
            <div className="k">behavior</div>
            <div className="v">{behavior || '—'}</div>
          </div>
          <div className="cell">
            <div className="k">format</div>
            <div className="v">{format}</div>
          </div>
          <div className="cell">
            <div className="k">被规则引用</div>
            <div className="v" style={{ color: usedBy > 0 ? 'var(--accent)' : 'var(--faint)' }}>
              {usedBy} 条
            </div>
          </div>
          <div className="cell">
            <div className="k">下发端点</div>
            <div className="v" style={{ color: 'var(--accent)' }}>
              {providerUrl || '—'}
            </div>
          </div>
        </div>

        <div className={styles.fields}>
          <div className={styles.col}>
            <span className={styles.lab}>格式</span>
            <select
              className="input mono"
              style={{ width: 100 }}
              value={format}
              onChange={(e) => setFormat(e.target.value as 'yaml' | 'text')}
            >
              <option value="yaml">yaml</option>
              <option value="text">text</option>
            </select>
          </div>
          <div className={styles.col}>
            <span className={styles.lab}>behavior</span>
            <select
              className="input mono"
              style={{ width: 130 }}
              value={behavior}
              onChange={(e) => setBehavior(e.target.value as Behavior | '')}
            >
              <option value="">（无）</option>
              <option value="classical">classical</option>
              <option value="domain">domain</option>
              <option value="ipcidr">ipcidr</option>
            </select>
          </div>
          <div className={styles.col}>
            <span className={styles.lab}>刷新(秒)</span>
            <input
              className="input mono"
              style={{ width: 110 }}
              placeholder="86400"
              value={interval}
              onChange={(e) => setIntervalStr(e.target.value)}
            />
          </div>
          <div className={styles.col} style={{ flex: 1, minWidth: 160 }}>
            <span className={styles.lab}>备注</span>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="一句话描述用途"
            />
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {usedBy > 0
            ? '已被规则引用，注入 rule-providers 并对外下发。'
            : '未被规则引用 · 留库不下发（到「规则」页加 RULE-SET 规则启用）。'}
          {behavior === 'domain' && (
            <span style={{ color: 'var(--faint)' }}> behavior=domain 时每行一个域名，性能优于 classical。</span>
          )}
        </div>

        <CodeEditor value={content} onChange={setContent} onSave={save} dirty={dirty} minHeight={300} />
      </div>
    </section>
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
  onSaved: () => Promise<void> | void;
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
      await api(`/api/v1/rule-sets/${set.id}/localize`, { method: 'POST' });
      await onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setLocalizing(false);
    }
  }

  const canLocalize = set.format !== 'mrs';

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="mono" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {set.name}
        </h2>
        <span className="pill idle plain">remote</span>
        <div className="grow" />
        <button className="btn sm" onClick={localize} disabled={!canLocalize || localizing}>
          {localizing ? '抓取中…' : '转为本地托管'}
        </button>
        <button className="btn primary sm" onClick={save} disabled={!dirty || saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button className="btn sm danger" onClick={onDelete}>
          删除
        </button>
      </div>
      <div className="panel-body">
        <div className={styles.metaGrid}>
          <div className="cell">
            <div className="k">host</div>
            <div className="v">{hostOf(set.url) || '—'}</div>
          </div>
          <div className="cell">
            <div className="k">format · behavior</div>
            <div className="v">
              {format}
              {behavior ? ` · ${behavior}` : ''}
            </div>
          </div>
          <div className="cell">
            <div className="k">被规则引用</div>
            <div className="v" style={{ color: usedBy > 0 ? 'var(--accent)' : 'var(--faint)' }}>
              {usedBy} 条
            </div>
          </div>
          <div className="cell">
            <div className="k">抓取方</div>
            <div className="v">mihomo 客户端</div>
          </div>
        </div>

        <div className="field">
          <label>外部 URL</label>
          <input
            className="input mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/rules.yaml"
          />
          <div className="hint">mihomo 直接抓取，平台不存内容。</div>
        </div>

        <div className={styles.fields}>
          <div className={styles.col}>
            <span className={styles.lab}>格式</span>
            <select
              className="input mono"
              style={{ width: 100 }}
              value={format}
              onChange={(e) => setFormat(e.target.value as Format)}
            >
              <option value="yaml">yaml</option>
              <option value="text">text</option>
              <option value="mrs">mrs</option>
            </select>
          </div>
          <div className={styles.col}>
            <span className={styles.lab}>behavior</span>
            <select
              className="input mono"
              style={{ width: 130 }}
              value={behavior}
              onChange={(e) => setBehavior(e.target.value as Behavior | '')}
            >
              <option value="">（无）</option>
              <option value="classical">classical</option>
              <option value="domain">domain</option>
              <option value="ipcidr">ipcidr</option>
            </select>
          </div>
          <div className={styles.col}>
            <span className={styles.lab}>刷新(秒)</span>
            <input
              className="input mono"
              style={{ width: 110 }}
              placeholder="86400"
              value={interval}
              onChange={(e) => setIntervalStr(e.target.value)}
            />
          </div>
          <div className={styles.col} style={{ minWidth: 140 }}>
            <span className={styles.lab}>下载代理</span>
            <input
              className="input mono"
              style={{ width: 140 }}
              placeholder="DIRECT"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
            />
          </div>
          <div className={styles.col} style={{ flex: 1, minWidth: 160 }}>
            <span className={styles.lab}>备注</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {canLocalize
            ? '「转为本地托管」会抓取该 URL 的当前内容存为本地规则集，之后由本平台分发、可直接在平台内维护。'
            : 'mrs 为二进制格式，无法转为本地文本托管。'}
        </div>
      </div>
    </section>
  );
}

/* ─── create form ───────────────────────────────────────────────────── */

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
    <form className="panel" onSubmit={submit}>
      <div className="panel-head">
        <h2>新建规则集</h2>
        <div className="grow" />
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn primary sm" disabled={pending}>
          {pending ? '创建中…' : '创建'}
        </button>
      </div>
      <div className="panel-body">
        <div className="field">
          <label>来源</label>
          <div className="seg">
            <button
              type="button"
              className={`opt${source === 'local' ? ' on' : ''}`}
              onClick={() => {
                setSource('local');
                if (format === 'mrs') setFormat('yaml');
              }}
            >
              本地托管（平台分发，可编辑）
            </button>
            <button
              type="button"
              className={`opt${source === 'remote' ? ' on' : ''}`}
              onClick={() => setSource('remote')}
            >
              外部 URL（mihomo 抓取）
            </button>
          </div>
        </div>

        <div className={styles.fields}>
          <div className={styles.col} style={{ flex: 1, minWidth: 180 }}>
            <span className={styles.lab}>名称 (slug)</span>
            <input
              className="input mono"
              placeholder="emby_classic"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-z0-9_-]+"
              required
            />
          </div>
          <div className={styles.col}>
            <span className={styles.lab}>格式</span>
            <select
              className="input mono"
              style={{ width: 100 }}
              value={format}
              onChange={(e) => setFormat(e.target.value as Format)}
            >
              <option value="yaml">yaml</option>
              <option value="text">text</option>
              {source === 'remote' && <option value="mrs">mrs</option>}
            </select>
          </div>
          <div className={styles.col}>
            <span className={styles.lab}>behavior</span>
            <select
              className="input mono"
              style={{ width: 130 }}
              value={behavior}
              onChange={(e) => setBehavior(e.target.value as Behavior | '')}
            >
              <option value="">（无）</option>
              <option value="classical">classical</option>
              <option value="domain">domain</option>
              <option value="ipcidr">ipcidr</option>
            </select>
          </div>
        </div>

        <div className={styles.fields}>
          <div className={styles.col}>
            <span className={styles.lab}>刷新(秒)</span>
            <input
              className="input mono"
              style={{ width: 120 }}
              placeholder="86400"
              value={interval}
              onChange={(e) => setIntervalStr(e.target.value)}
            />
          </div>
          <div className={styles.col} style={{ minWidth: 140 }}>
            <span className={styles.lab}>下载代理（可选）</span>
            <input
              className="input mono"
              style={{ width: 140 }}
              placeholder="DIRECT"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
            />
          </div>
          <div className={styles.col} style={{ flex: 1, minWidth: 160 }}>
            <span className={styles.lab}>备注（可选）</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {source === 'remote' ? (
          <div className="field">
            <label>外部 URL</label>
            <input
              className="input mono"
              placeholder="https://example.com/rules.mrs"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>
        ) : (
          <div className="field">
            <label>内容</label>
            <CodeEditor value={content} onChange={setContent} minHeight={300} hint="" />
          </div>
        )}

        {error && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--danger)',
              background: 'var(--danger-dim)',
              borderRadius: 'var(--r-sm)',
              padding: '8px 11px',
            }}
          >
            {error}
          </div>
        )}
      </div>
    </form>
  );
}
