'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';
import type { OperatorStep } from '@/lib/proxies/operators';
import { REGIONS } from '@/lib/proxies/regions';
import { PROXY_TYPES, type Operator, type OperatorKind } from '@/schemas/operator';

/* ─── meta ─────────────────────────────────────────────────────────── */

const KIND_META: Record<OperatorKind, { title: string; desc: string }> = {
  'filter-regex': { title: '正则过滤', desc: '按名称正则保留或排除节点' },
  'filter-useless': { title: '去除无用节点', desc: '丢弃流量 / 到期 / 官网等信息节点' },
  'rename-regex': { title: '正则重命名', desc: '正则替换节点名（替换为空 = 删除）' },
  'flag-emoji': { title: '国旗 Emoji', desc: '按地区在名称前加上或移除国旗' },
  'filter-type': { title: '类型过滤', desc: '按协议类型保留或排除节点' },
  sort: { title: '排序', desc: '按名称 / 类型 / 服务器 / 地区排序' },
  'set-prop': { title: '设置属性', desc: '强制 UDP / TFO / 跳过证书校验' },
  dedup: { title: '处理重复节点', desc: '按名称或 server:port 去重' },
  'filter-region': { title: '地区过滤', desc: '按识别出的地区保留或排除' },
};

/** Operator menu order = the feature numbering 1–9. */
const KIND_ORDER: OperatorKind[] = [
  'filter-regex',
  'filter-useless',
  'rename-regex',
  'flag-emoji',
  'filter-type',
  'sort',
  'set-prop',
  'dedup',
  'filter-region',
];

function makeOperator(kind: OperatorKind): Operator {
  const id = crypto.randomUUID();
  switch (kind) {
    case 'filter-regex':
      return { id, kind, mode: 'keep', pattern: '', flags: 'i' };
    case 'filter-useless':
      return { id, kind, extra: [] };
    case 'rename-regex':
      return { id, kind, pattern: '', replacement: '', flags: 'gi' };
    case 'flag-emoji':
      return { id, kind, action: 'add' };
    case 'filter-type':
      return { id, kind, mode: 'keep', types: [] };
    case 'sort':
      return { id, kind, by: 'name', order: 'asc' };
    case 'set-prop':
      return { id, kind };
    case 'dedup':
      return { id, kind, by: 'name', action: 'drop' };
    case 'filter-region':
      return { id, kind, mode: 'keep', regions: [] };
  }
}

/** A step is sendable to preview only when its required fields are filled + valid. */
function isComplete(op: Operator): boolean {
  switch (op.kind) {
    case 'filter-regex':
    case 'rename-regex': {
      const p = op.pattern?.trim();
      if (!p) return false;
      try {
        new RegExp(p, op.flags ?? '');
        return true;
      } catch {
        return false;
      }
    }
    case 'filter-type':
      return op.types.length > 0;
    case 'filter-region':
      return op.regions.length > 0;
    default:
      return true;
  }
}

function summarize(op: Operator): string {
  switch (op.kind) {
    case 'filter-regex':
      return `${op.mode === 'keep' ? '保留' : '排除'} · /${op.pattern || '…'}/${op.flags ?? ''}`;
    case 'filter-useless':
      return op.extra.length ? `内置 + ${op.extra.length} 额外关键词` : '内置规则';
    case 'rename-regex':
      return `/${op.pattern || '…'}/ → ${op.replacement === '' ? '（删除）' : op.replacement}`;
    case 'flag-emoji':
      return op.action === 'add'
        ? op.tw2cn
          ? '添加国旗 · 台湾→🇨🇳'
          : '添加国旗'
        : '移除国旗';
    case 'filter-type':
      return `${op.mode === 'keep' ? '保留' : '排除'} · ${op.types.join(' ') || '未选类型'}`;
    case 'sort':
      return `${{ name: '名称', type: '类型', server: '服务器', region: '地区' }[op.by]} ${op.order === 'asc' ? '↑' : '↓'}`;
    case 'set-prop': {
      const bits: string[] = [];
      if (op.udp !== undefined) bits.push(`UDP ${op.udp ? '开' : '关'}`);
      if (op.tfo !== undefined) bits.push(`TFO ${op.tfo ? '开' : '关'}`);
      if (op.skipCertVerify !== undefined) bits.push(`跳过证书 ${op.skipCertVerify ? '开' : '关'}`);
      return bits.join(' · ') || '未设置';
    }
    case 'dedup':
      return `${op.by === 'name' ? '按名称' : '按 server:port'} · ${op.action === 'drop' ? '丢弃' : '重命名'}`;
    case 'filter-region':
      return `${op.mode === 'keep' ? '保留' : '排除'} · ${op.regions.join(' ') || '未选地区'}`;
  }
}

/* ─── page ─────────────────────────────────────────────────────────── */

interface PreviewData {
  before: { count: number; names: string[]; truncated: boolean };
  after: { count: number; names: string[]; truncated: boolean };
  steps: OperatorStep[];
}

interface SubLite {
  id: string;
  name: string;
  kind: 'remote' | 'local';
  operators?: Operator[];
}

export default function PipelinePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [sub, setSub] = useState<SubLite | null>(null);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [savedKey, setSavedKey] = useState('[]');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const reqId = useRef(0);

  const operatorsKey = useMemo(() => JSON.stringify(operators), [operators]);
  const dirty = operatorsKey !== savedKey;
  const incompleteCount = operators.filter((op) => !isComplete(op)).length;

  /* load */
  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ data: SubLite }>(`/api/v1/subscriptions/${id}`);
        const ops = res.data.operators ?? [];
        setSub(res.data);
        setOperators(ops);
        setSavedKey(JSON.stringify(ops));
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoaded(true);
      }
    })();
  }, [id]);

  /* preview — only complete operators are sendable; disabled ones still go
     so the engine reports an applied:false step aligned by id. */
  const runPreview = useCallback(
    async (ops: Operator[]) => {
      const payload = ops.filter(isComplete);
      const my = ++reqId.current;
      setPreviewing(true);
      setPreviewError(null);
      try {
        const res = await api<{ data: PreviewData }>(`/api/v1/subscriptions/${id}/preview`, {
          method: 'POST',
          body: { operators: payload },
        });
        if (my === reqId.current) setPreview(res.data);
      } catch (err) {
        if (my === reqId.current) {
          setPreviewError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
        }
      } finally {
        if (my === reqId.current) setPreviewing(false);
      }
    },
    [id],
  );

  /* debounced auto-preview */
  useEffect(() => {
    if (!loaded || loadError) return;
    const t = setTimeout(() => runPreview(JSON.parse(operatorsKey) as Operator[]), 450);
    return () => clearTimeout(t);
  }, [operatorsKey, loaded, loadError, runPreview]);

  /* warn on unsaved navigation */
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  /* mutations */
  const addOp = (kind: OperatorKind) => {
    const op = makeOperator(kind);
    setOperators((prev) => [...prev, op]);
    setExpandedId(op.id);
    setAddOpen(false);
  };
  const updateOp = (i: number, next: Operator) =>
    setOperators((prev) => prev.map((o, idx) => (idx === i ? next : o)));
  const removeOp = (i: number) =>
    setOperators((prev) => prev.filter((_, idx) => idx !== i));
  const toggleOp = (i: number) =>
    setOperators((prev) =>
      prev.map((o, idx) => (idx === i ? ({ ...o, disabled: !o.disabled } as Operator) : o)),
    );
  const moveOp = (i: number, dir: -1 | 1) =>
    setOperators((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  async function save() {
    if (incompleteCount > 0) return;
    setSaving(true);
    try {
      const res = await api<{ data: SubLite }>(`/api/v1/subscriptions/${id}`, {
        method: 'PATCH',
        body: { operators },
      });
      setSub((prev) => (prev ? { ...prev, ...res.data } : res.data));
      setSavedKey(JSON.stringify(operators));
    } catch (err) {
      setPreviewError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setSaving(false);
    }
  }

  function leave() {
    if (dirty && !confirm('有未保存的流水线改动，确定离开？')) return;
    router.push('/subscriptions');
  }

  const stepById = useMemo(() => {
    const m = new Map<string, OperatorStep>();
    for (const s of preview?.steps ?? []) m.set(s.id, s);
    return m;
  }, [preview]);

  return (
    <div className="-mx-8 -mt-8 -mb-12 flex flex-col h-screen">
      {/* top bar */}
      <header className="shrink-0 flex items-center justify-between gap-4 px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-baseline gap-3 min-w-0">
          <button
            type="button"
            onClick={leave}
            className="pm-focus-ring rounded text-[12px] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors -ml-1 mr-1 active:scale-[0.98]"
            title="返回订阅源"
          >
            ← 订阅源
          </button>
          <h1
            className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)] truncate"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            {sub?.name ?? '…'}
          </h1>
          <span className="text-[11px] uppercase tracking-[0.08em] font-mono text-[var(--color-muted)] shrink-0">
            节点处理
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {dirty ? (
            <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-warn)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warn)]" />
              未保存
            </span>
          ) : (
            loaded &&
            !loadError && <span className="text-[11px] text-[var(--color-muted)]">已是最新</span>
          )}
          <Button variant="secondary" size="sm" onClick={() => runPreview(operators)} disabled={previewing}>
            {previewing ? '预览中…' : '预览'}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={saving || !dirty || incompleteCount > 0}
            title={incompleteCount > 0 ? `有 ${incompleteCount} 个算子未填写完整` : undefined}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      {loadError && (
        <div className="shrink-0 px-6 py-2 text-[12px] bg-[#F4D8D2]/40 text-[var(--color-danger)] border-b border-[var(--color-border)]">
          {loadError}
        </div>
      )}

      {/* body: pipeline | preview */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        {/* ── left: pipeline ── */}
        <section className="border-r border-[var(--color-border)] bg-[var(--color-bg-sunk)] overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 bg-[var(--color-bg-sunk)]/95 backdrop-blur-sm border-b border-[var(--color-border)]">
            <h2 className="text-[11px] uppercase tracking-[0.1em] font-semibold text-[var(--color-muted)]">
              流水线
              <span className="ml-2 tabular-nums font-mono text-[var(--color-fg-soft)]">
                {operators.length}
              </span>
            </h2>
            <div className="relative">
              <Button variant="secondary" size="sm" onClick={() => setAddOpen((v) => !v)}>
                + 算子
              </Button>
              {addOpen && (
                <>
                  <button
                    type="button"
                    aria-label="关闭菜单"
                    className="fixed inset-0 z-20 cursor-default"
                    onClick={() => setAddOpen(false)}
                  />
                  <div className="absolute right-0 mt-1.5 z-30 w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-modal)] overflow-hidden py-1">
                    {KIND_ORDER.map((kind, n) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => addOp(kind)}
                        className="pm-focus-ring w-full text-left px-3 py-2 flex items-baseline gap-2.5 hover:bg-[var(--color-bg-sunk)] transition-colors active:scale-[0.99]"
                      >
                        <span className="text-[10px] font-mono tabular-nums text-[var(--color-muted-strong)] w-4 shrink-0">
                          {n + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] text-[var(--color-fg)]">
                            {KIND_META[kind].title}
                          </span>
                          <span className="block text-[11px] text-[var(--color-muted)] leading-snug">
                            {KIND_META[kind].desc}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="p-4 space-y-2">
            {operators.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/40 px-6 py-10 text-center">
                <p className="text-[13px] text-[var(--color-fg-soft)]">还没有算子</p>
                <p className="mt-1 text-[12px] text-[var(--color-muted)]">
                  点右上「+ 算子」添加第一个处理步骤，节点会按从上到下的顺序流过。
                </p>
              </div>
            ) : (
              operators.map((op, i) => (
                <OperatorCard
                  key={op.id}
                  op={op}
                  index={i}
                  total={operators.length}
                  step={stepById.get(op.id)}
                  complete={isComplete(op)}
                  expanded={expandedId === op.id}
                  onToggleExpand={() => setExpandedId((cur) => (cur === op.id ? null : op.id))}
                  onChange={(next) => updateOp(i, next)}
                  onToggle={() => toggleOp(i)}
                  onRemove={() => removeOp(i)}
                  onMoveUp={() => moveOp(i, -1)}
                  onMoveDown={() => moveOp(i, 1)}
                />
              ))
            )}
          </div>
        </section>

        {/* ── right: preview ── */}
        <PreviewPane
          preview={preview}
          previewing={previewing}
          error={previewError}
          loaded={loaded && !loadError}
        />
      </div>
    </div>
  );
}

/* ─── operator card ────────────────────────────────────────────────── */

function OperatorCard({
  op,
  index,
  total,
  step,
  complete,
  expanded,
  onToggleExpand,
  onChange,
  onToggle,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  op: Operator;
  index: number;
  total: number;
  step?: OperatorStep;
  complete: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onChange: (next: Operator) => void;
  onToggle: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const disabled = !!op.disabled;
  return (
    <div
      className={`rounded-lg border bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden transition-[border-color,opacity] duration-150 ${
        !complete
          ? 'border-[var(--color-warn)]/50'
          : expanded
            ? 'border-[var(--color-primary)]/40'
            : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2.5 pl-2.5 pr-2 py-2.5">
        <ReorderStepper
          onUp={onMoveUp}
          onDown={onMoveDown}
          upDisabled={index === 0}
          downDisabled={index === total - 1}
        />
        <span className="font-mono text-[11px] tabular-nums text-[var(--color-muted-strong)] w-3.5 text-center shrink-0">
          {index + 1}
        </span>

        {/* title + summary — whole block toggles expand */}
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="pm-focus-ring rounded min-w-0 flex-1 text-left active:scale-[0.99]"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-semibold tracking-[-0.005em] text-[var(--color-fg)] truncate">
              {KIND_META[op.kind].title}
            </span>
            {!complete && (
              <span className="shrink-0 text-[10px] leading-none px-1.5 py-1 rounded-sm bg-[#F5E5C9] text-[var(--color-warn)]">
                待填写
              </span>
            )}
            {disabled && (
              <span className="shrink-0 text-[10px] leading-none px-1.5 py-1 rounded-sm bg-[var(--color-bg-sunk)] text-[var(--color-muted)]">
                已停用
              </span>
            )}
          </span>
          <span className="block text-[11px] text-[var(--color-muted)] font-mono truncate mt-1">
            {summarize(op)}
          </span>
        </button>

        <TraceChip step={step} disabled={disabled} />

        <div className="flex items-center gap-0.5 shrink-0">
          <IconBtn
            label={disabled ? '▶' : '⏸'}
            title={disabled ? '启用' : '停用'}
            onClick={onToggle}
          />
          <IconBtn label="✕" title="删除" onClick={onRemove} tone="danger" />
        </div>

        {/* expand chevron */}
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? '收起' : '展开'}
          className="pm-focus-ring w-6 h-7 rounded inline-flex items-center justify-center text-[var(--color-muted-strong)] hover:text-[var(--color-fg)] transition-colors active:scale-[0.9] shrink-0"
        >
          <span
            aria-hidden
            className={`text-[10px] transition-transform duration-150 ease-out ${expanded ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
        </button>
      </div>

      {expanded && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-sunk)]/40 px-4 py-4">
          <OperatorEditor op={op} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function TraceChip({ step, disabled }: { step?: OperatorStep; disabled: boolean }) {
  if (disabled) return null;
  if (!step) return <span className="shrink-0 w-9" />; // reserve width for layout calm
  if (!step.applied) return <span className="shrink-0 w-9" />;
  if (step.dropped > 0) {
    return (
      <span className="shrink-0 text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded-sm bg-[#F4D8D2] text-[var(--color-danger)]">
        −{step.dropped}
      </span>
    );
  }
  if (step.changed > 0) {
    return (
      <span className="shrink-0 text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded-sm bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]">
        ✎{step.changed}
      </span>
    );
  }
  return <span className="shrink-0 w-9 text-center text-[11px] text-[var(--color-muted-strong)]">—</span>;
}

/** 28px icon action button — shares the Dossier card's IconButton vocabulary. */
function IconBtn({
  label,
  title,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  const color =
    tone === 'danger'
      ? 'text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/8'
      : 'text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg-sunk)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`pm-focus-ring w-7 h-7 rounded inline-flex items-center justify-center text-[13px] leading-none transition-colors active:scale-[0.9] disabled:opacity-25 disabled:cursor-not-allowed ${color}`}
    >
      <span aria-hidden>{label}</span>
    </button>
  );
}

/** Vertical reorder stepper (⌃ / ⌄) — a deliberate control, not floating arrows. */
function ReorderStepper({
  onUp,
  onDown,
  upDisabled,
  downDisabled,
}: {
  onUp: () => void;
  onDown: () => void;
  upDisabled: boolean;
  downDisabled: boolean;
}) {
  const base =
    'pm-focus-ring h-3.5 w-5 inline-flex items-center justify-center text-[9px] leading-none text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg-sunk)] disabled:opacity-25 disabled:cursor-not-allowed transition-colors active:scale-[0.9]';
  return (
    <div className="flex flex-col rounded-md border border-[var(--color-border)] overflow-hidden shrink-0 bg-[var(--color-surface)]">
      <button type="button" onClick={onUp} disabled={upDisabled} title="上移" aria-label="上移" className={base}>
        <span aria-hidden>⌃</span>
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={downDisabled}
        title="下移"
        aria-label="下移"
        className={`${base} border-t border-[var(--color-border)]`}
      >
        <span aria-hidden>⌄</span>
      </button>
    </div>
  );
}

/* ─── operator editors ─────────────────────────────────────────────── */

function OperatorEditor({ op, onChange }: { op: Operator; onChange: (next: Operator) => void }) {
  switch (op.kind) {
    case 'filter-regex':
      return (
        <div className="flex flex-col gap-3.5">
          <EditorField label="模式">
            <Segmented
              value={op.mode}
              onChange={(v) => onChange({ ...op, mode: v as 'keep' | 'drop' })}
              options={[
                { value: 'keep', label: '保留匹配' },
                { value: 'drop', label: '排除匹配' },
              ]}
            />
          </EditorField>
          <EditorField label="正则表达式">
            <Input
              value={op.pattern}
              onChange={(e) => onChange({ ...op, pattern: e.target.value })}
              placeholder="香港|HK|🇭🇰"
              className="font-mono text-[12px]"
            />
          </EditorField>
          <FlagToggle flags={op.flags} onChange={(f) => onChange({ ...op, flags: f })} />
        </div>
      );

    case 'filter-useless':
      return (
        <div className="flex flex-col gap-3.5">
          <p className="text-[11px] text-[var(--color-muted)] leading-relaxed">
            自动丢弃含「剩余流量 / 到期 / 重置 / 官网 / 续费 / 客服 / 群组 / 网址」等关键词的信息节点。
          </p>
          <EditorField label="额外关键词（逗号分隔）">
            <Input
              value={op.extra.join(', ')}
              onChange={(e) =>
                onChange({
                  ...op,
                  extra: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="可选，如 测试, 体验"
              className="font-mono text-[12px]"
            />
          </EditorField>
        </div>
      );

    case 'rename-regex':
      return (
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <EditorField label="匹配正则">
              <Input
                value={op.pattern}
                onChange={(e) => onChange({ ...op, pattern: e.target.value })}
                placeholder="\\[.*?\\]"
                className="font-mono text-[12px]"
              />
            </EditorField>
            <EditorField label="替换为（留空 = 删除）">
              <Input
                value={op.replacement}
                onChange={(e) => onChange({ ...op, replacement: e.target.value })}
                placeholder=""
                className="font-mono text-[12px]"
              />
            </EditorField>
          </div>
          <FlagToggle flags={op.flags} onChange={(f) => onChange({ ...op, flags: f })} />
        </div>
      );

    case 'flag-emoji':
      return (
        <div className="flex flex-col gap-3.5">
          <EditorField label="操作">
            <Segmented
              value={op.action}
              onChange={(v) => onChange({ ...op, action: v as 'add' | 'remove' })}
              options={[
                { value: 'add', label: '添加国旗' },
                { value: 'remove', label: '移除国旗' },
              ]}
            />
          </EditorField>
          {op.action === 'add' && (
            <EditorField label="台湾节点旗帜">
              <Segmented
                value={op.tw2cn ? 'cn' : 'tw'}
                onChange={(v) => onChange({ ...op, tw2cn: v === 'cn' })}
                options={[
                  { value: 'tw', label: '🇹🇼 台湾旗' },
                  { value: 'cn', label: '🇨🇳 中国旗' },
                ]}
              />
            </EditorField>
          )}
        </div>
      );

    case 'filter-type':
      return (
        <div className="flex flex-col gap-3.5">
          <EditorField label="模式">
            <Segmented
              value={op.mode}
              onChange={(v) => onChange({ ...op, mode: v as 'keep' | 'drop' })}
              options={[
                { value: 'keep', label: '保留所选' },
                { value: 'drop', label: '排除所选' },
              ]}
            />
          </EditorField>
          <EditorField label="协议类型">
            <div className="flex flex-wrap gap-1.5">
              {PROXY_TYPES.map((t) => (
                <ToggleChip
                  key={t}
                  active={op.types.includes(t)}
                  onClick={() =>
                    onChange({
                      ...op,
                      types: op.types.includes(t)
                        ? op.types.filter((x) => x !== t)
                        : [...op.types, t],
                    })
                  }
                >
                  {t}
                </ToggleChip>
              ))}
            </div>
          </EditorField>
        </div>
      );

    case 'sort':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <EditorField label="排序依据">
            <Segmented
              compact
              value={op.by}
              onChange={(v) => onChange({ ...op, by: v as 'name' | 'type' | 'server' | 'region' })}
              options={[
                { value: 'name', label: '名称' },
                { value: 'region', label: '地区' },
                { value: 'type', label: '类型' },
                { value: 'server', label: '服务器' },
              ]}
              wrap
            />
          </EditorField>
          <EditorField label="顺序">
            <Segmented
              value={op.order}
              onChange={(v) => onChange({ ...op, order: v as 'asc' | 'desc' })}
              options={[
                { value: 'asc', label: '升序 ↑' },
                { value: 'desc', label: '降序 ↓' },
              ]}
            />
          </EditorField>
        </div>
      );

    case 'set-prop':
      return (
        <div className="flex flex-col gap-2.5">
          <TriRow label="UDP" value={op.udp} onChange={(v) => onChange({ ...op, udp: v })} />
          <TriRow label="TCP Fast Open" value={op.tfo} onChange={(v) => onChange({ ...op, tfo: v })} />
          <TriRow
            label="跳过证书校验"
            value={op.skipCertVerify}
            onChange={(v) => onChange({ ...op, skipCertVerify: v })}
          />
        </div>
      );

    case 'dedup':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <EditorField label="判定依据">
            <Segmented
              value={op.by}
              onChange={(v) => onChange({ ...op, by: v as 'name' | 'server-port' })}
              options={[
                { value: 'name', label: '名称' },
                { value: 'server-port', label: 'server:port' },
              ]}
            />
          </EditorField>
          <EditorField label="对重复项">
            <Segmented
              value={op.action}
              onChange={(v) => onChange({ ...op, action: v as 'drop' | 'rename' })}
              options={[
                { value: 'drop', label: '丢弃' },
                { value: 'rename', label: '加序号' },
              ]}
            />
          </EditorField>
        </div>
      );

    case 'filter-region':
      return (
        <div className="flex flex-col gap-3.5">
          <EditorField label="模式">
            <Segmented
              value={op.mode}
              onChange={(v) => onChange({ ...op, mode: v as 'keep' | 'drop' })}
              options={[
                { value: 'keep', label: '保留所选' },
                { value: 'drop', label: '排除所选' },
              ]}
            />
          </EditorField>
          <EditorField label="地区">
            <div className="flex flex-wrap gap-1.5">
              {REGIONS.map((r) => (
                <ToggleChip
                  key={r.code}
                  active={op.regions.includes(r.code)}
                  onClick={() =>
                    onChange({
                      ...op,
                      regions: op.regions.includes(r.code)
                        ? op.regions.filter((x) => x !== r.code)
                        : [...op.regions, r.code],
                    })
                  }
                >
                  <span className="mr-1">{r.emoji}</span>
                  {r.zh}
                </ToggleChip>
              ))}
            </div>
          </EditorField>
        </div>
      );
  }
}

/** Caption + control stack. A div (not a label) so it can safely wrap button groups. */
function EditorField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="block text-[10px] uppercase tracking-[0.06em] text-[var(--color-muted)] mb-1.5">
        {label}
      </span>
      {children}
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
  compact,
  wrap,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  compact?: boolean;
  wrap?: boolean;
}) {
  return (
    <div
      className={`inline-flex ${wrap ? 'flex-wrap' : ''} gap-1 p-0.5 rounded-lg bg-[var(--color-bg-sunk)] border border-[var(--color-border)]`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`pm-focus-ring rounded-md ${compact ? 'px-2' : 'px-2.5'} py-1 text-[12px] transition-colors active:scale-[0.97] ${
              active
                ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-card)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Case-insensitive (`i`) flag toggle for regex operators; preserves other flags. */
function FlagToggle({ flags, onChange }: { flags?: string; onChange: (f: string) => void }) {
  const ci = (flags ?? '').includes('i');
  const toggle = () => {
    const set = new Set((flags ?? '').split('').filter(Boolean));
    if (ci) set.delete('i');
    else set.add('i');
    onChange([...set].join(''));
  };
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none w-fit">
      <input
        type="checkbox"
        checked={ci}
        onChange={toggle}
        className="accent-[var(--color-primary)] w-4 h-4 shrink-0"
      />
      <span className="inline-flex items-baseline gap-1 text-[12px] leading-none text-[var(--color-fg-soft)]">
        忽略大小写
        <span className="font-mono text-[var(--color-muted)]">(i)</span>
      </span>
    </label>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pm-focus-ring rounded-md px-2 py-1 text-[12px] font-mono transition-colors active:scale-[0.97] border ${
        active
          ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)] border-[var(--color-primary)]/30'
          : 'bg-[var(--color-surface)] text-[var(--color-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
      }`}
    >
      {children}
    </button>
  );
}

/** Tri-state row: 不变 / 开 / 关 mapping to undefined / true / false. */
function TriRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (v: boolean | undefined) => void;
}) {
  const cur = value === undefined ? 'keep' : value ? 'on' : 'off';
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-[var(--color-fg-soft)]">{label}</span>
      <Segmented
        value={cur}
        onChange={(v) => onChange(v === 'keep' ? undefined : v === 'on')}
        options={[
          { value: 'keep', label: '不变' },
          { value: 'on', label: '开' },
          { value: 'off', label: '关' },
        ]}
      />
    </div>
  );
}

/* ─── preview pane ─────────────────────────────────────────────────── */

function PreviewPane({
  preview,
  previewing,
  error,
  loaded,
}: {
  preview: PreviewData | null;
  previewing: boolean;
  error: string | null;
  loaded: boolean;
}) {
  const [side, setSide] = useState<'after' | 'before'>('after');
  const list = preview ? preview[side] : null;
  const delta = preview ? preview.after.count - preview.before.count : 0;

  return (
    <section className="overflow-y-auto bg-[var(--color-bg)] flex flex-col">
      <div className="sticky top-0 z-10 px-5 py-3 bg-[var(--color-bg)]/95 backdrop-blur-sm border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] uppercase tracking-[0.1em] font-semibold text-[var(--color-muted)]">
            预览{previewing && <span className="ml-2 text-[var(--color-muted-strong)] normal-case tracking-normal">运行中…</span>}
          </h2>
          <Segmented
            value={side}
            onChange={(v) => setSide(v as 'after' | 'before')}
            options={[
              { value: 'after', label: '处理后' },
              { value: 'before', label: '处理前' },
            ]}
            compact
          />
        </div>
        {preview && (
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[14px] font-mono tabular-nums text-[var(--color-muted)]">
              {preview.before.count}
            </span>
            <span className="text-[var(--color-muted-strong)]">→</span>
            <span
              className="font-serif text-[26px] leading-none font-medium tabular-nums text-[var(--color-ink)]"
              style={{ fontVariationSettings: '"opsz" 48, "SOFT" 40' }}
            >
              {preview.after.count}
            </span>
            <span className="text-[11px] text-[var(--color-muted)]">节点</span>
            {delta !== 0 && (
              <span
                className={`ml-1 text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded-sm ${
                  delta < 0
                    ? 'bg-[#F4D8D2] text-[var(--color-danger)]'
                    : 'bg-[#E6EEDD] text-[var(--color-success)]'
                }`}
              >
                {delta > 0 ? `+${delta}` : delta}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 px-5 py-4">
        {error ? (
          <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[#F4D8D2]/30 px-4 py-3 text-[12px] text-[var(--color-danger)] break-words">
            {error}
          </div>
        ) : !loaded || !list ? (
          <p className="text-[13px] text-[var(--color-muted)]">加载中…</p>
        ) : list.names.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)] italic">无节点</p>
        ) : (
          <ul className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
            {list.names.map((name, i) => (
              <li
                key={`${i}-${name}`}
                className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-[var(--color-bg-sunk)] transition-colors"
              >
                <span className="text-[10px] font-mono tabular-nums text-[var(--color-muted-strong)] w-7 text-right shrink-0">
                  {i + 1}
                </span>
                <span className="text-[12px] font-mono text-[var(--color-fg)] truncate">{name}</span>
              </li>
            ))}
            {list.truncated && (
              <li className="px-3 py-1.5 text-[11px] text-[var(--color-muted)] font-mono">
                … 仅显示前 {list.names.length} 个，共 {list.count} 个
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
